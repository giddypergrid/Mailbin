/**
 * Gmail Sync Architecture
 * =======================
 *
 * Triggered every page load (frontend fire-and-forget). Backend processes
 * unread emails since last_synced_at, writing to DB oldest-first so new
 * emails stack chronologically after existing ones — no gap.
 *
 * Flow:
 *   1. Baseline (first connect, last_synced_at = null):
 *      Fetch up to MAILBIN_SYNC_BASELINE_MAX (50) most recent unread.
 *   2. Incremental (has last_synced_at):
 *      Fetch up to MAILBIN_SYNC_INCREMENTAL_MAX (200, 0 = no cap) emails
 *      received after last_synced_at. Paginates through all Gmail pages.
 *   3. Reverse all IDs → oldest-first for chronological DB insertion.
 *   4. Dedup against DB (fetchExistingMessageIds).
 *   5. Process in batches: fetch detail → Gemini classify → upsert.
 *   6. Only advance last_synced_at when sync completed cleanly:
 *      !hasError && !hasMore. Baseline hitting cap sets cursor to 1 day
 *      before oldest processed email.
 *
 * Error reporting (uniform fallback to frontend, no internal retries):
 *   Every failure surfaces as `errorStage` to the frontend:
 *     - 'gmail-list'   — messages.list call failed (non-2xx)
 *     - 'gmail-detail' — one or more messages.get calls failed
 *     - 'gemini-rate'  — Gemini 429/503 (RPM/quota exceeded)
 *     - 'gemini-parse' — Gemini returned malformed / empty response
 *   Backend dictates `retryAfterMs` per stage (see CONFIG.sync.retryAfter).
 *   Frontend shows a small "!" notice and waits the dictated interval.
 *   When `hasError` is true, last_synced_at is NOT advanced so the failed
 *   range gets retried on the next sync.
 *
 * Exit-and-come-back resilience:
 *   Same path as the error case — last_synced_at only advances on clean
 *   completion. Already-processed emails are deduplicated against the DB.
 */

import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { log, logWeird } from '../_shared/logger.ts';
import { classifyWithGemini } from '../_shared/gemini.ts';
import { parseFromHeader } from '../_shared/mail-builder.ts';
import { processAttachments } from '../_shared/attachment-processor.ts';
import { type GmailPart, type GmailMessageResponse } from '../_shared/types.ts';
import { CONFIG } from '../_shared/config.ts';
import { fetchMessageList, fetchMessageDetail, getValidAccessToken } from '../_shared/gmail-client.ts';
import { fetchUserConnection, fetchCoreMemory, fetchExistingMessageIds, upsertEmail, updateLastSyncedAt } from '../_shared/db.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

type ErrorStage = 'gmail-list' | 'gmail-detail' | 'gemini-rate' | 'gemini-parse';
type BinKey = 'emergency' | 'info' | 'maybe';

function getHeader(message: { payload?: { headers?: Array<{ name: string; value: string }> } }, name: string): string {
  return message.payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function collectAttachments(parts: GmailPart[] | undefined): Array<{ filename: string; mimeType: string; sizeBytes: number; attachmentId?: string }> {
  if (!parts) return [];
  const results: Array<{ filename: string; mimeType: string; sizeBytes: number; attachmentId?: string }> = [];
  for (const part of parts) {
    if (part.filename) results.push({ filename: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', sizeBytes: part.body?.size ?? 0, attachmentId: part.body?.attachmentId });
    if (part.parts) results.push(...collectAttachments(part.parts));
  }
  return results;
}

// Gmail encodes body data as base64url. Decode → UTF-8 string.
function decodeBase64Url(data: string): string {
  const standard = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  try {
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

// Strip HTML tags + decode common entities + collapse whitespace.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, digits) => String.fromCharCode(parseInt(digits, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Walk Gmail's nested payload to find the first part of a given mime type.
function findBodyData(node: { mimeType?: string; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }> } | undefined, mimeType: string): string | null {
  if (!node) return null;
  if (node.mimeType === mimeType && node.body?.data) return node.body.data;
  if (node.parts) {
    for (const part of node.parts) {
      const found = findBodyData(part as never, mimeType);
      if (found) return found;
    }
  }
  return null;
}

// Prefer text/plain, fall back to stripped text/html, fall back to snippet.
function extractBody(message: GmailMessageResponse, maxChars: number): string {
  const payload = message.payload;
  if (payload) {
    const plain = findBodyData(payload, 'text/plain');
    if (plain) {
      const decoded = decodeBase64Url(plain).replace(/\s+/g, ' ').trim();
      if (decoded) return decoded.slice(0, maxChars);
    }
    const html = findBodyData(payload, 'text/html');
    if (html) {
      const decoded = stripHtml(decodeBase64Url(html));
      if (decoded) return decoded.slice(0, maxChars);
    }
  }
  return message.snippet || '';
}

function formatDateForGmail(isoDate: string): string {
  const date = new Date(isoDate);
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const clean = words.filter((word) => {
    if (/^https?:\/\//i.test(word)) return false;
    if (word.length > 25) return false;
    return true;
  });
  if (clean.length === 0) return '';
  return clean.slice(0, maxWords).join(' ');
}

function retryAfterMsFor(stage: ErrorStage): number {
  const waits = CONFIG.sync.retryAfter;
  switch (stage) {
    case 'gemini-rate':  return waits.geminiRate;
    case 'gemini-parse': return waits.geminiParse;
    case 'gmail-list':
    case 'gmail-detail': return waits.gmailTransient;
  }
}

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const supabaseUrl = requireEnv('MAILBIN_SUPABASE_URL');
    const serviceRoleKey = requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY');
    const userId = await verifyJwt(req);
    if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);

    const connection = await fetchUserConnection(supabaseUrl, serviceRoleKey, userId);
    if (!connection) return jsonResponse({ syncedCount: 0 });

    const coreMemory = await fetchCoreMemory(supabaseUrl, serviceRoleKey, userId);
    const maxAttachmentKb = coreMemory?.attachment_max_size_kb ?? CONFIG.coreMemory.attachmentKbDefault;
    const customRules = (coreMemory?.custom_rules && coreMemory.custom_rules.length > 0)
      ? coreMemory.custom_rules
      : CONFIG.coreMemory.defaultRules;

    const accessToken = await getValidAccessToken(connection, supabaseUrl, serviceRoleKey);

    const isBaseline = !connection.last_synced_at;
    const maxEmails = isBaseline ? CONFIG.sync.baselineMax : CONFIG.sync.incrementalMax;
    // category:primary excludes Promotions / Social / Updates / Forums tabs.
    const gmailQuery = isBaseline
      ? 'in:inbox is:unread category:primary'
      : `in:inbox category:primary after:${formatDateForGmail(connection.last_synced_at!)}`;

    log('GMAIL-SYNC', 'Starting', { userId, isBaseline, maxEmails, gmailQuery });

    // 1. Fetch ALL message IDs (paginate until exhausted or hit cap)
    const allIds: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;
    let gmailListFailed = false;

    while (true) {
      const remaining = maxEmails > 0
        ? maxEmails - allIds.length
        : CONFIG.fetch.gmailListPageSize;
      if (maxEmails > 0 && remaining <= 0) break;

      const listResult = await fetchMessageList(
        accessToken,
        Math.min(remaining, CONFIG.fetch.gmailListPageSize),
        pageToken,
        gmailQuery,
      );

      if (!listResult.ok) {
        logWeird('GMAIL-SYNC', 'Gmail list failed', { status: listResult.status, userId });
        gmailListFailed = true;
        break;
      }

      if (listResult.data.messages) {
        allIds.push(...listResult.data.messages.map((message) => ({
          id: message.id,
          threadId: message.threadId,
        })));
      }
      pageToken = listResult.data.nextPageToken;
      if (!pageToken) break;
    }

    if (gmailListFailed) {
      const errorStage: ErrorStage = 'gmail-list';
      return jsonResponse({
        syncedCount: 0,
        syncedByBin: { emergency: 0, info: 0, maybe: 0 } as Record<BinKey, number>,
        hasMore: false,
        hasError: true,
        errorStage,
        failedCount: 0,
        retryAfterMs: retryAfterMsFor(errorStage),
        isBaseline,
      });
    }

    let hasMore: boolean;
    if (maxEmails === 0) {
      hasMore = pageToken != null;
    } else {
      hasMore = allIds.length >= maxEmails;
    }

    if (allIds.length === 0) {
      await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id);
      return jsonResponse({
        syncedCount: 0,
        syncedByBin: { emergency: 0, info: 0, maybe: 0 } as Record<BinKey, number>,
        hasMore: false,
        hasError: false,
        errorStage: null,
        failedCount: 0,
        isBaseline,
      });
    }

    // 2. Dedup against already-synced emails in DB
    const gmailIds = allIds.map((message) => message.id);
    const existingIds = await fetchExistingMessageIds(supabaseUrl, serviceRoleKey, userId, gmailIds);
    const existingSet = new Set(existingIds);
    const newMessages = allIds.filter((message) => !existingSet.has(message.id));

    if (newMessages.length === 0) {
      await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id);
      return jsonResponse({
        syncedCount: 0,
        syncedByBin: { emergency: 0, info: 0, maybe: 0 } as Record<BinKey, number>,
        hasMore: false,
        hasError: false,
        errorStage: null,
        failedCount: 0,
        isBaseline,
      });
    }

    // 3. Reverse → oldest-first for chronological DB insertion
    newMessages.reverse();

    // 4. Process in batches
    //    - fetchConcurrency: ≤10 → avoid Gmail 429 bursts
    //    - classifyBatchSize: 50 → amortise system-prompt cost across emails
    let syncedCount = 0;
    const syncedByBin: Record<BinKey, number> = { emergency: 0, info: 0, maybe: 0 };
    const fetchConcurrency = CONFIG.fetch.batchSize;
    const classifyBatchSize = CONFIG.fetch.classifyBatchSize;
    const batchDelay = CONFIG.fetch.batchDelayMs;
    let oldestReceivedAt: string | null = null;
    const failedMessageIds: string[] = [];
    let geminiErrorStage: 'gemini-rate' | 'gemini-parse' | null = null;

    // Rate-limit pacer: track Gemini call timestamps in this invocation.
    // Before each call, if RPM quota would be exceeded within the trailing 60s
    // window, sleep until the oldest call falls out of the window.
    const geminiCallTimestamps: number[] = [];
    const rpmLimit = CONFIG.gemini.rpm;
    async function waitForRpmSlot() {
      while (geminiCallTimestamps.length >= rpmLimit) {
        const oldest = geminiCallTimestamps[0];
        const elapsed = Date.now() - oldest;
        if (elapsed >= 60_000) {
          geminiCallTimestamps.shift();
        } else {
          const sleepMs = 60_000 - elapsed + 250;
          log('GMAIL-SYNC', 'Pacing for Gemini RPM', { sleepMs, rpmLimit });
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
        }
      }
    }

    for (let batchStart = 0; batchStart < newMessages.length; batchStart += classifyBatchSize) {
      const classifyBatch = newMessages.slice(batchStart, batchStart + classifyBatchSize);

      // Fetch Gmail details in small concurrent chunks
      const validMessages: GmailMessageResponse[] = [];
      for (let chunkStart = 0; chunkStart < classifyBatch.length; chunkStart += fetchConcurrency) {
        const fetchChunk = classifyBatch.slice(chunkStart, chunkStart + fetchConcurrency);
        const details = await Promise.all(fetchChunk.map(async ({ id }) => {
          const result = await fetchMessageDetail(accessToken, id);
          if (!result.ok) {
            failedMessageIds.push(id);
            return null;
          }
          return result.data;
        }));
        for (const detail of details) {
          if (detail !== null) validMessages.push(detail);
        }
        if (chunkStart + fetchConcurrency < classifyBatch.length) {
          await new Promise((resolve) => setTimeout(resolve, batchDelay));
        }
      }

      if (validMessages.length === 0) continue;

      // 2000 chars ≈ 500 tokens per email; full HTML body stripped to text.
      const emailInputs = validMessages.map((message) => ({
        id: message.id,
        from: getHeader(message, 'From'),
        subject: getHeader(message, 'Subject') || '(No subject)',
        snippet: message.snippet || '',
        body: extractBody(message, 2000),
      }));

      // Split the batch into N-email chunks fired at Gemini in PARALLEL.
      // Same RPM cost as one big call (chunkSize ≤ rpmLimit assumed) but
      // wall-clock drops because per-call latency is sub-linear in input size.
      // Partial failure: successful chunks upsert, failed chunks' emails are
      // pushed to failedMessageIds and retried on next sync via DB dedup.
      const classification: Record<string, { bin: string; summary: string; theme: string; fromWho: string; isCustomized: boolean }> = {};
      const successfulIds = new Set<string>();

      if (CONFIG.gemini.apiKey) {
        const chunkSize = CONFIG.gemini.chunkSize;
        const chunks: Array<typeof emailInputs> = [];
        for (let chunkStart = 0; chunkStart < emailInputs.length; chunkStart += chunkSize) {
          chunks.push(emailInputs.slice(chunkStart, chunkStart + chunkSize));
        }

        const chunkResults = await Promise.all(chunks.map(async (chunk) => {
          await waitForRpmSlot();
          geminiCallTimestamps.push(Date.now());
          const outcome = await classifyWithGemini(userId, customRules, chunk);
          return { chunk, outcome };
        }));

        for (const { chunk, outcome } of chunkResults) {
          if (outcome.errorStage === 'rate') {
            geminiErrorStage = 'gemini-rate';
          } else if (outcome.errorStage === 'parse' && geminiErrorStage !== 'gemini-rate') {
            geminiErrorStage = 'gemini-parse';
          }

          if (outcome.errorStage) {
            for (const email of chunk) failedMessageIds.push(email.id);
            continue;
          }

          Object.assign(classification, outcome.classifications);
          for (const email of chunk) successfulIds.add(email.id);
        }

        if (geminiErrorStage) {
          logWeird('GMAIL-SYNC', 'Gemini partial failure', {
            userId,
            errorStage: geminiErrorStage,
            failedChunkCount: chunkResults.filter((entry) => entry.outcome.errorStage).length,
            successfulChunkCount: chunkResults.filter((entry) => !entry.outcome.errorStage).length,
          });
        }
      } else {
        for (const message of validMessages) successfulIds.add(message.id);
      }

      const messagesToUpsert = validMessages.filter((message) => successfulIds.has(message.id));
      const upsertRecords = messagesToUpsert.map((message) => {
        const geminiResult = classification[message.id];
        const fromValue = getHeader(message, 'From');
        const fromParsed = parseFromHeader(fromValue);
        const subject = getHeader(message, 'Subject') || '(No subject)';
        const receivedAt = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
        const labelIds = message.labelIds ?? [];
        const isReadInGmail = !labelIds.includes('UNREAD');
        const rawAttachments = collectAttachments(message.payload?.parts);
        const attachmentResult = rawAttachments.length > 0 ? processAttachments(rawAttachments, maxAttachmentKb) : null;

        return {
          payload: {
            user_id: userId,
            gmail_message_id: message.id,
            thread_id: message.threadId,
            from_name: fromParsed.name,
            from_email: fromParsed.email,
            subject,
            summary: truncateWords(geminiResult?.summary || message.snippet || subject, 10),
            received_at: receivedAt,
            bin: geminiResult?.bin || 'maybe',
            ai_theme: geminiResult?.theme || (CONFIG.gemini.apiKey && !geminiResult ? 'Unclassified' : ''),
            ai_from_who: geminiResult?.fromWho || fromParsed.name,
            is_customized: geminiResult?.isCustomized ?? false,
            is_read: isReadInGmail,
            has_attachments: rawAttachments.length > 0,
            attachment_total_kb: attachmentResult ? Math.round(attachmentResult.totalKb) : 0,
          },
          receivedAt,
          binKey: (geminiResult?.bin || 'maybe') as BinKey,
        };
      });

      // Parallel DB upserts — was 50 sequential awaits, now one Promise.all.
      await Promise.all(upsertRecords.map(({ payload }) =>
        upsertEmail(supabaseUrl, serviceRoleKey, payload),
      ));

      for (const { receivedAt, binKey } of upsertRecords) {
        syncedCount++;
        if (binKey in syncedByBin) syncedByBin[binKey]++;
        if (receivedAt && (!oldestReceivedAt || receivedAt < oldestReceivedAt)) {
          oldestReceivedAt = receivedAt;
        }
      }

      // If any chunk in this batch failed, stop after the current batch so the
      // frontend can wait + retry with the failed-IDs picked up via DB dedup.
      if (geminiErrorStage) break;

      if (batchStart + classifyBatchSize < newMessages.length) {
        await new Promise((resolve) => setTimeout(resolve, batchDelay));
      }
    }

    // 5. Resolve final error state
    let errorStage: ErrorStage | null = null;
    if (geminiErrorStage) {
      errorStage = geminiErrorStage;
    } else if (failedMessageIds.length > 0) {
      errorStage = 'gmail-detail';
    }
    const hasError = errorStage !== null;

    // 6. Advance last_synced_at only on clean completion. Any error keeps the
    //    cursor where it is so the failed range is retried next sync; dedup
    //    skips successes.
    if (!hasError) {
      if (!hasMore) {
        await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id);
      } else if (isBaseline && oldestReceivedAt) {
        const cursor = new Date(oldestReceivedAt);
        cursor.setDate(cursor.getDate() - 1);
        await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id, cursor.toISOString());
      }
    }

    log('GMAIL-SYNC', 'Complete', { userId, syncedCount, isBaseline, hasMore, hasError, errorStage });
    return jsonResponse({
      syncedCount,
      syncedByBin,
      hasMore,
      hasError,
      errorStage,
      failedCount: failedMessageIds.length,
      retryAfterMs: errorStage ? retryAfterMsFor(errorStage) : undefined,
      isBaseline,
    });
  } catch (error) {
    logWeird('GMAIL-SYNC', 'Sync failed', { reason: error instanceof Error ? error.message : String(error) });
    return jsonResponse({ error: error instanceof Error ? error.message : 'sync_failed' }, 500);
  }
});
