import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { logWeird, log } from '../_shared/logger.ts';
import { CONFIG } from '../_shared/config.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

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
      const response = await fetch(
        `${supabaseUrl}/rest/v1/core_memory?user_id=eq.${userId}&limit=1`,
        { headers },
      );

      if (!response.ok) {
        return jsonResponse({ error: 'Failed to load core memory' }, 500);
      }

      const rows = await response.json() as Record<string, unknown>[];

      if (rows.length === 0) {
        log('CORE-MEMORY', 'No row found — returning defaults', { userId });
        return jsonResponse({
          customRules: CONFIG.coreMemory.defaultRules,
          attachmentMaxSizeKb: CONFIG.coreMemory.attachmentKbDefault,
          sendAttachmentsToAi: false,
        });
      }

      const row = rows[0];

      log('CORE-MEMORY', 'Loaded', { userId });

      return jsonResponse({
        customRules: Array.isArray(row.custom_rules) ? row.custom_rules : [],
        attachmentMaxSizeKb: row.attachment_max_size_kb ?? 100,
        sendAttachmentsToAi: row.send_attachments_to_ai ?? false,
        markEmailsAsRead: row.mark_emails_as_read ?? false,
      });
    }

    if (req.method === 'PUT') {
      const body = await req.json();
      const updatePayload: Record<string, unknown> = { user_id: userId };

      if (Array.isArray(body.customRules)) {
        const maxRules = CONFIG.coreMemory.maxRules;
        const maxRuleLength = CONFIG.coreMemory.maxRuleLength;
        const sanitized = body.customRules
          .filter((r: unknown) => typeof r === 'string')
          .map((r: string) => r.trim())
          .filter((r: string) => r.length > 0)
          .slice(0, maxRules)
          .map((r: string) => r.slice(0, maxRuleLength));
        updatePayload.custom_rules = sanitized;
      }

      if (typeof body.attachmentMaxSizeKb === 'number') {
        const kbMin = CONFIG.coreMemory.attachmentKbMin;
        const kbMax = CONFIG.coreMemory.attachmentKbMax;
        updatePayload.attachment_max_size_kb = Math.min(Math.max(body.attachmentMaxSizeKb, kbMin), kbMax);
      }

      if (typeof body.sendAttachmentsToAi === 'boolean') updatePayload.send_attachments_to_ai = body.sendAttachmentsToAi;
      if (typeof body.markEmailsAsRead === 'boolean') updatePayload.mark_emails_as_read = body.markEmailsAsRead;

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
