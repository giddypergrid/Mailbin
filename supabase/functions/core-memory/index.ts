import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { logWeird, log } from '../_shared/logger.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const DEFAULT_MEMORY = [
  'Promotional emails from shopping sites, newsletters, marketing → maybe.',
  'Legal documents, bank statements, tax info, government notices → emergency.',
  'Work emails from colleagues and managers → emergency.',
  'Social media notifications → info.',
  'Meeting invites, calendar reminders → info.',
].join('\n');

const supabaseHeaders = (serviceRoleKey: string) => ({
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  'Content-Type': 'application/json',
});

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);

  if (corsResponse) {
    return corsResponse;
  }

  try {
    const userId = await verifyJwt(req);

    if (!userId) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const supabaseUrl = requireEnv('MAILBIN_SUPABASE_URL');
    const serviceRoleKey = requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY');
    const headers = supabaseHeaders(serviceRoleKey);

    if (req.method === 'GET') {
      await fetch(`${supabaseUrl}/rest/v1/core_memory`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify({
          user_id: userId,
          memory_text: DEFAULT_MEMORY,
        }),
      });

      const response = await fetch(
        `${supabaseUrl}/rest/v1/core_memory?user_id=eq.${userId}&limit=1`,
        { headers },
      );

      if (!response.ok) {
        return jsonResponse({ error: 'Failed to load core memory' }, 500);
      }

      const rows = await response.json() as Record<string, unknown>[];

      if (rows.length === 0) {
        return jsonResponse({ error: 'Core memory not found after insert' }, 500);
      }

      const row = rows[0];

      log('CORE-MEMORY', 'Loaded', { userId });

      return jsonResponse({
        memoryText: row.memory_text ?? '',
        summaryMaxWords: row.summary_max_words ?? 10,
        attachmentMaxSizeKb: row.attachment_max_size_kb ?? 100,
        sendAttachmentsToAi: row.send_attachments_to_ai ?? false,
      });
    }

    if (req.method === 'PUT') {
      const body = await req.json();
      const updatePayload: Record<string, unknown> = { user_id: userId };

      if (typeof body.memoryText === 'string') updatePayload.memory_text = body.memoryText;
      if (typeof body.summaryMaxWords === 'number') updatePayload.summary_max_words = body.summaryMaxWords;
      if (typeof body.attachmentMaxSizeKb === 'number') updatePayload.attachment_max_size_kb = body.attachmentMaxSizeKb;
      if (typeof body.sendAttachmentsToAi === 'boolean') updatePayload.send_attachments_to_ai = body.sendAttachmentsToAi;

      updatePayload.updated_at = new Date().toISOString();

      const upsertResponse = await fetch(
        `${supabaseUrl}/rest/v1/core_memory?on_conflict=user_id`,
        {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(updatePayload),
        },
      );

      if (!upsertResponse.ok) {
        logWeird('CORE-MEMORY', 'Upsert failed', { status: upsertResponse.status });
        return jsonResponse({ error: 'Failed to save core memory' }, 500);
      }

      log('CORE-MEMORY', 'Saved', { userId });

      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
  } catch (error) {
    logWeird('CORE-MEMORY', 'Request failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
