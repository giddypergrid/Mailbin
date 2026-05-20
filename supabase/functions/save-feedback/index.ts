import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { logWeird } from '../_shared/logger.ts';
import { fetchUserConnection, markEmailRead } from '../_shared/db.ts';
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

    const body = await req.json() as { gmailMessageId?: string; feedbackText?: string };
    const { gmailMessageId, feedbackText } = body;
    if (!gmailMessageId) return jsonResponse({ error: 'gmailMessageId required' }, 400);

    const wordCount = feedbackText ? feedbackText.trim().split(/\s+/).filter(Boolean).length : 0;
    if (wordCount > 30) {
      return jsonResponse({ error: 'Feedback exceeds 30 words' }, 400);
    }

    const connection = await fetchUserConnection(supabaseUrl, serviceRoleKey, userId);
    if (!connection) return jsonResponse({ error: 'No Gmail connection' }, 400);

    const accessToken = await getValidAccessToken(connection, supabaseUrl, serviceRoleKey);

    const feedbackResult = await fetch(`${supabaseUrl}/rest/v1/user_feedback`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userId,
        gmail_message_id: gmailMessageId,
        feedback_text: feedbackText ?? '',
      }),
    });

    let gmailResult = false;
    let dbResult = false;
    if (feedbackResult.ok) {
      [gmailResult, dbResult] = await Promise.all([
        markMessageRead(accessToken, gmailMessageId).catch(() => false),
        markEmailRead(supabaseUrl, serviceRoleKey, userId, gmailMessageId),
      ]);
    }

    if (!feedbackResult.ok) {
      logWeird('SAVE-FEEDBACK', 'Insert failed', { status: feedbackResult.status });
      return jsonResponse({ error: 'feedback_save_failed' }, 500);
    }

    return jsonResponse({
      saved: feedbackResult.ok,
      dbMarkedRead: dbResult,
      gmailMarkedRead: gmailResult === true,
    });
  } catch (error) {
    logWeird('SAVE-FEEDBACK', 'Failed', { reason: error instanceof Error ? error.message : String(error) });
    return jsonResponse({ error: 'save_feedback_failed' }, 500);
  }
});
