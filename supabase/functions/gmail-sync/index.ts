/**
 * Gmail Sync Architecture
 * =======================
 *
 * Triggered every page load (frontend fire-and-forget). Backend processes
 * all unread emails since last_synced_at, writing to DB oldest-first so
 * new emails stack chronologically after existing ones — no gap.
 *
 * Flow:
 *   1. Baseline (first connect, last_synced_at = null):
 *      Fetch up to MAILBIN_SYNC_BASELINE_MAX (50) most recent unread.
 *   2. Incremental (has last_synced_at):
 *      Fetch up to MAILBIN_SYNC_INCREMENTAL_MAX (200, 0 = no cap) emails
 *      received after last_synced_at. Paginates through all Gmail pages.
 *   3. Reverse all IDs → oldest-first for chronological DB insertion.
 *   4. Dedup against DB (fetchExistingMessageIds). If user exited mid-sync
 *      last time, already-processed emails are skipped — no duplicates.
 *   5. Process in batches of 3: fetch detail → Gemini classify → upsert.
 *   6. Rate limit (429/503): retry up to 3 times with 5s delay (built
 *      into gmail-client.ts).
 *   7. Only advance last_synced_at when hasMore = false (fully caught up).
 *      Baseline hitting cap: set to 1 day before oldest processed email so
 *      next call catches remaining unread via incremental after: query.
 *
 * Exit-and-come-back resilience:
 *   - If user exits mid-sync, last_synced_at is NOT updated (hasMore was
 *     still true). Next page load re-queries the same date range from
 *     Gmail. Already-processed emails are deduplicated by DB check.
 *     Remaining emails fill in chronologically at the oldest end first.
 *   - No gap because we sync oldest-first each time.
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

function getHeader(message: { payload?: { headers?: Array<{ name: string; value: string }> } }, name: string): string {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
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

function formatDateForGmail(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
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

function gmailPageSize(): number {
  return 20;
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
    const gmailQuery = isBaseline
      ? 'in:inbox is:unread'
      : `in:inbox after:${formatDateForGmail(connection.last_synced_at!)}`;

    log('GMAIL-SYNC', 'Starting', { userId, isBaseline, maxEmails, gmailQuery });

    // 1. Fetch ALL message IDs (paginate until exhausted or hit cap)
    const allIds: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;

    collectLoop:
    while (true) {
      const remaining = maxEmails > 0 ? maxEmails - allIds.length : gmailPageSize();
      if (maxEmails > 0 && remaining <= 0) break;

      const list = await fetchMessageList(accessToken, Math.min(remaining, gmailPageSize()), pageToken, gmailQuery);
      if (list.messages) {
        allIds.push(...list.messages.map((m) => ({ id: m.id, threadId: m.threadId })));
      }
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }

    // hasMore: Gmail has more pages AND we either hit the cap or there's genuinely more
    let hasMore: boolean;
    if (maxEmails === 0) {
      hasMore = pageToken != null;
    } else {
      hasMore = allIds.length >= maxEmails;
    }

    if (allIds.length === 0) {
      await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id);
      return jsonResponse({ syncedCount: 0, hasMore: false, isBaseline });
    }

    // 2. Dedup against already-synced emails in DB
    const gmailIds = allIds.map((m) => m.id);
    const existingIds = await fetchExistingMessageIds(supabaseUrl, serviceRoleKey, userId, gmailIds);
    const existingSet = new Set(existingIds);
    const newMessages = allIds.filter((m) => !existingSet.has(m.id));

    if (newMessages.length === 0) {
      // All fetched IDs already in DB — advance cursor to break stale baseline loop
      await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id);
      return jsonResponse({ syncedCount: 0, hasMore: false, isBaseline });
    }

    // 3. Reverse → oldest-first for chronological DB insertion
    newMessages.reverse();

    // 4. Process in batches
    //    - fetchConcurrency: small (≤5) → avoid Gmail 429
    //    - classifyBatchSize: large (≥15) → amortize system-prompt cost across emails
    let syncedCount = 0;
    const fetchConcurrency = CONFIG.fetch.batchSize;
    const classifyBatchSize = CONFIG.fetch.classifyBatchSize;
    const batchDelay = CONFIG.fetch.batchDelayMs;
    let oldestReceivedAt: string | null = null;

    for (let i = 0; i < newMessages.length; i += classifyBatchSize) {
      const classifyBatch = newMessages.slice(i, i + classifyBatchSize);

      // Fetch Gmail details in small concurrent chunks
      const validMessages: GmailMessageResponse[] = [];
      for (let j = 0; j < classifyBatch.length; j += fetchConcurrency) {
        const fetchChunk = classifyBatch.slice(j, j + fetchConcurrency);
        const details = await Promise.all(fetchChunk.map(async ({ id }) => {
          const { ok, data } = await fetchMessageDetail(accessToken, id);
          return ok ? data : null;
        }));
        for (const d of details) {
          if (d !== null) validMessages.push(d);
        }
        if (j + fetchConcurrency < classifyBatch.length) {
          await new Promise((r) => setTimeout(r, batchDelay));
        }
      }

      if (validMessages.length === 0) continue;

      const emailInputs = validMessages.map((m) => ({
        id: m.id,
        from: getHeader(m, 'From'),
        subject: getHeader(m, 'Subject') || '(No subject)',
        snippet: m.snippet || '',
      }));

      // One Gemini call for the whole batch — amortizes system prompt
      let classification: Record<string, { bin: string; summary: string; theme: string; fromWho: string; isCustomized: boolean }> = {};
      if (CONFIG.gemini.apiKey) {
        classification = await classifyWithGemini(userId, customRules, emailInputs);
      }

      const classifiedCount = Object.keys(classification).length;
      if (CONFIG.gemini.apiKey && classifiedCount === 0) {
        logWeird('GMAIL-SYNC', 'Classification empty — falling back to maybe with Unclassified theme', {
          userId,
          batchSize: validMessages.length,
        });
      }

      for (const msg of validMessages) {
        const geminiResult = classification[msg.id];
        const fromValue = getHeader(msg, 'From');
        const fromParsed = parseFromHeader(fromValue);
        const subject = getHeader(msg, 'Subject') || '(No subject)';
        const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;
        const labelIds = msg.labelIds ?? [];
        const isReadInGmail = !labelIds.includes('UNREAD');

        const rawAttachments = collectAttachments(msg.payload?.parts);
        const attachmentResult = rawAttachments.length > 0 ? processAttachments(rawAttachments, maxAttachmentKb) : null;

        await upsertEmail(supabaseUrl, serviceRoleKey, {
          user_id: userId,
          gmail_message_id: msg.id,
          thread_id: msg.threadId,
          from_name: fromParsed.name,
          from_email: fromParsed.email,
          subject,
          summary: truncateWords(geminiResult?.summary || msg.snippet || subject, 10),
          received_at: receivedAt,
          bin: geminiResult?.bin || 'maybe',
          ai_theme: geminiResult?.theme || (CONFIG.gemini.apiKey && !geminiResult ? 'Unclassified' : ''),
          ai_from_who: geminiResult?.fromWho || fromParsed.name,
          is_customized: geminiResult?.isCustomized ?? false,
          is_read: isReadInGmail,
          has_attachments: rawAttachments.length > 0,
          attachment_total_kb: attachmentResult ? Math.round(attachmentResult.totalKb) : 0,
        });
        syncedCount++;
        if (receivedAt && (!oldestReceivedAt || receivedAt < oldestReceivedAt)) {
          oldestReceivedAt = receivedAt;
        }
      }

      if (i + classifyBatchSize < newMessages.length) {
        await new Promise((r) => setTimeout(r, batchDelay));
      }
    }

    // 5. Advance last_synced_at
    if (!hasMore) {
      await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id);
    } else if (isBaseline && oldestReceivedAt) {
      // Baseline hit the cap — set cursor to 1 day before oldest processed email
      // so next call catches remaining unread via incremental after: query
      const d = new Date(oldestReceivedAt);
      d.setDate(d.getDate() - 1);
      await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id, d.toISOString());
    }

    log('GMAIL-SYNC', 'Complete', { userId, syncedCount, isBaseline, hasMore });
    return jsonResponse({ syncedCount, hasMore, isBaseline });
  } catch (error) {
    logWeird('GMAIL-SYNC', 'Sync failed', { reason: error instanceof Error ? error.message : String(error) });
    return jsonResponse({ error: error instanceof Error ? error.message : 'sync_failed' }, 500);
  }
});
