import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { logWeird } from '../_shared/logger.ts';

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

    const response = await fetch(
      `${supabaseUrl}/rest/v1/gmail_connections?user_id=eq.${userId}`,
      {
        method: 'DELETE',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      }
    );

    if (!response.ok) {
      logWeird('GMAIL-DISCONNECT', 'DB delete failed', { status: response.status });
      return jsonResponse({ error: 'disconnect_failed' }, 500);
    }

    return jsonResponse({ disconnected: true });
  } catch (error) {
    logWeird('GMAIL-DISCONNECT', 'Failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: 'disconnect_failed' }, 500);
  }
});
