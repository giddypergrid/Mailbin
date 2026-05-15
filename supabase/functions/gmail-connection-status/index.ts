import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { logWeird } from '../_shared/logger.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);

  if (corsResponse) {
    return corsResponse;
  }

  const userId = await verifyJwt(req);

  if (!userId) {
    return jsonResponse({ connected: false });
  }

  try {
    const supabaseUrl = requireEnv('MAILBIN_SUPABASE_URL');
    const serviceRoleKey = requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY');
    const response = await fetch(`${supabaseUrl}/rest/v1/gmail_connections?select=id&user_id=eq.${userId}&limit=1`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });

    if (!response.ok) {
      throw new Error('gmail_connection_status_failed');
    }

    const rows = await response.json() as Array<{ id: string }>;

    return jsonResponse({ connected: rows.length > 0 });
  } catch (error) {
    logWeird('CONNECTION-STATUS', 'Check failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({
      connected: false,
      status: 'error',
      reason: error instanceof Error ? error.message : 'gmail_connection_status_failed',
    }, 500);
  }
});
