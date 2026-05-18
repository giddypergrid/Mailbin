import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { logWeird } from '../_shared/logger.ts';
import { type GmailEmailRow } from '../_shared/types.ts';
import { fetchEmails } from '../_shared/db.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const requestUrl = new URL(req.url);
    const bin = requestUrl.searchParams.get('bin') ?? undefined;
    const before = requestUrl.searchParams.get('before') ?? undefined;
    const limitParam = requestUrl.searchParams.get('limit');
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 50) : 20;

    const supabaseUrl = requireEnv('MAILBIN_SUPABASE_URL');
    const serviceRoleKey = requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY');
    const userId = await verifyJwt(req);

    if (!userId) {
      return jsonResponse({ messages: [], nextCursor: null });
    }

    const { rows, nextCursor } = await fetchEmails(supabaseUrl, serviceRoleKey, userId, bin, before, limit);

    const messages = rows.map(toMailItem);
    return jsonResponse({ messages, nextCursor });
  } catch (error) {
    logWeird('GMAIL-MAILS', 'Fetch failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ messages: [], nextCursor: null, error: 'fetch_failed' }, 500);
  }
});

function toMailItem(row: GmailEmailRow) {
  return {
    id: `gmail-${row.gmail_message_id}`,
    bin: row.bin,
    from: row.from_email ? `${row.from_name} <${row.from_email}>` : row.from_name,
    subject: row.subject,
    summary: row.summary,
    receivedAt: row.received_at ? new Date(row.received_at).toLocaleDateString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '',
    gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${row.gmail_message_id}`,
    source: 'gmail',
    aiSummary: row.summary,
    aiTheme: row.ai_theme,
    aiFromWho: row.ai_from_who,
    attachments: [],
    attachmentTotalKb: row.attachment_total_kb,
    hasAttachments: row.has_attachments,
  };
}
