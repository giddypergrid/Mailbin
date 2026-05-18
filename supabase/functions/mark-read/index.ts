import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { logWeird } from '../_shared/logger.ts';
import { fetchUserConnection } from '../_shared/db.ts';
import { getValidAccessToken, markMessageRead } from '../_shared/gmail-client.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const supabaseUrl = requireEnv('MAILBIN_SUPABASE_URL');
    const serviceRoleKey = requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY');
    const userId = await verifyJwt(req);
    if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);

    const body = await req.json() as { gmailMessageId?: string; markGmail?: boolean };
    const gmailMessageId = body.gmailMessageId;
    if (!gmailMessageId) return jsonResponse({ error: 'gmailMessageId required' }, 400);

    const connection = await fetchUserConnection(supabaseUrl, serviceRoleKey, userId);
    if (!connection) return jsonResponse({ error: 'No Gmail connection' }, 400);

    const accessToken = await getValidAccessToken(connection, supabaseUrl, serviceRoleKey);

    const dbPromise = fetch(`${supabaseUrl}/rest/v1/gmail_emails?user_id=eq.${userId}&gmail_message_id=eq.${gmailMessageId}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_read: true }),
    });

    const markGmail = body.markGmail !== false;
    const gmailPromise = markGmail
      ? markMessageRead(accessToken, gmailMessageId).catch(() => false)
      : Promise.resolve(null);

    const [dbResult, gmailResult] = await Promise.all([dbPromise, gmailPromise]);

    if (!dbResult.ok) {
      logWeird('MARK-READ', 'DB update failed', { status: dbResult.status, gmailMessageId });
    }

    return jsonResponse({ markedRead: dbResult.ok, gmailMarkedRead: gmailResult === true });
  } catch (error) {
    logWeird('MARK-READ', 'Failed', { reason: error instanceof Error ? error.message : String(error) });
    return jsonResponse({ error: 'mark_read_failed' }, 500);
  }
});
