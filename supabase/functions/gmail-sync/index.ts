import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { log, logWeird } from '../_shared/logger.ts';
import { classifyWithGemini } from '../_shared/gemini.ts';
import { parseFromHeader } from '../_shared/mail-builder.ts';
import { processAttachments } from '../_shared/attachment-processor.ts';
import { type GmailPart } from '../_shared/types.ts';
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
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
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
    const summaryMaxWords = coreMemory?.summary_max_words ?? CONFIG.summaryMaxWords;
    const systemInstruction = coreMemory?.memory_text ?? '';

    const accessToken = await getValidAccessToken(connection, supabaseUrl, serviceRoleKey);

    const isBaseline = !connection.last_synced_at;
    const targetCount = isBaseline ? 50 : 20;
    const gmailQuery = isBaseline
      ? 'in:inbox is:unread'
      : `in:inbox after:${formatDateForGmail(connection.last_synced_at!)}`;

    log('GMAIL-SYNC', 'Starting', { isBaseline, targetCount, gmailQuery });

    const allIds: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;

    while (allIds.length < targetCount) {
      const list = await fetchMessageList(accessToken, Math.min(targetCount - allIds.length, 20), pageToken, gmailQuery);
      if (list.messages) allIds.push(...list.messages.map((m) => ({ id: m.id, threadId: m.threadId })));
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }

    if (allIds.length === 0) {
      await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id);
      return jsonResponse({ syncedCount: 0, hasMore: false, isBaseline });
    }

    const gmailIds = allIds.map((m) => m.id);
    const existingIds = await fetchExistingMessageIds(supabaseUrl, serviceRoleKey, userId, gmailIds);
    const existingSet = new Set(existingIds);
    const newMessages = allIds.filter((m) => !existingSet.has(m.id));

    if (newMessages.length === 0) {
      await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id);
      return jsonResponse({ syncedCount: 0, hasMore: false, isBaseline });
    }

    let syncedCount = 0;
    const batchSize = CONFIG.fetch.batchSize;
    const batchDelay = CONFIG.fetch.batchDelayMs;

    for (let i = 0; i < newMessages.length; i += batchSize) {
      const batch = newMessages.slice(i, i + batchSize);
      const details = await Promise.all(batch.map(async ({ id }) => {
        const { ok, data } = await fetchMessageDetail(accessToken, id);
        return ok ? data : null;
      }));
      const validMessages = details.filter((d) => d !== null);
      if (validMessages.length === 0) continue;

      const emailInputs = validMessages.map((m) => ({
        id: m.id,
        from: getHeader(m, 'From'),
        subject: getHeader(m, 'Subject') || '(No subject)',
        snippet: m.snippet || '',
      }));

      let classification: Record<string, { bin: string; summary: string; theme: string; fromWho: string }> = {};
      if (CONFIG.gemini.apiKey && systemInstruction) {
        classification = await classifyWithGemini(systemInstruction, emailInputs, summaryMaxWords);
      }

      for (const msg of validMessages) {
        const geminiResult = classification[msg.id];
        const fromValue = getHeader(msg, 'From');
        const fromParsed = parseFromHeader(fromValue);
        const subject = getHeader(msg, 'Subject') || '(No subject)';
        const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;

        const rawAttachments = collectAttachments(msg.payload?.parts);
        const attachmentResult = rawAttachments.length > 0 ? processAttachments(rawAttachments, maxAttachmentKb) : null;

        await upsertEmail(supabaseUrl, serviceRoleKey, {
          user_id: userId,
          gmail_message_id: msg.id,
          thread_id: msg.threadId,
          from_name: fromParsed.name,
          from_email: fromParsed.email,
          subject,
          summary: geminiResult?.summary || msg.snippet || subject,
          received_at: receivedAt,
          bin: geminiResult?.bin || 'maybe',
          ai_theme: geminiResult?.theme || '',
          ai_from_who: geminiResult?.fromWho || fromParsed.name,
          has_attachments: rawAttachments.length > 0,
          attachment_total_kb: attachmentResult ? Math.round(attachmentResult.totalKb) : 0,
        });
        syncedCount++;
      }

      if (i + batchSize < newMessages.length) {
        await new Promise((r) => setTimeout(r, batchDelay));
      }
    }

    await updateLastSyncedAt(supabaseUrl, serviceRoleKey, connection.id);

    log('GMAIL-SYNC', 'Complete', { syncedCount, isBaseline });
    return jsonResponse({ syncedCount, hasMore: allIds.length >= targetCount, isBaseline });
  } catch (error) {
    logWeird('GMAIL-SYNC', 'Sync failed', { reason: error instanceof Error ? error.message : String(error) });
    return jsonResponse({ error: error instanceof Error ? error.message : 'sync_failed' }, 500);
  }
});
