import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { logWeird } from '../_shared/logger.ts';
import { fetchCoreMemory, fetchUserConnection, markEmailRead } from '../_shared/db.ts';
import { getValidAccessToken, markMessageRead } from '../_shared/gmail-client.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

// Supabase Edge Runtime extension — keeps background promises alive past the
// response. If unavailable (local dev), the fetch still fires but may be cut
// short. The unprocessed feedback row remains, so the next submission catches
// up. Best-effort by design.
type EdgeRuntime = { waitUntil(promise: Promise<unknown>): void };
function backgroundTask(promise: Promise<unknown>) {
  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntime }).EdgeRuntime;
  runtime?.waitUntil?.(promise);
}

function fireProcessFeedback(supabaseUrl: string, authHeader: string) {
  // Re-derive custom_rules from all unprocessed feedback. Errors are
  // non-fatal — the feedback row stays unprocessed and is picked up next time.
  const url = `${supabaseUrl}/functions/v1/process-feedback`;
  const task = fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader },
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        logWeird('SAVE-FEEDBACK', 'process-feedback non-OK', { status: response.status, body: text.slice(0, 200) });
      }
    })
    .catch((error) => {
      logWeird('SAVE-FEEDBACK', 'process-feedback chain failed', { reason: String(error) });
    });
  backgroundTask(task);
}

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

    const coreMemory = await fetchCoreMemory(supabaseUrl, serviceRoleKey, userId);
    const shouldMarkGmail = coreMemory?.mark_emails_as_read ?? false;

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

    if (!feedbackResult.ok) {
      logWeird('SAVE-FEEDBACK', 'Insert failed', { status: feedbackResult.status });
      return jsonResponse({ error: 'feedback_save_failed' }, 500);
    }

    // Mark read: DB always (so the email leaves the bin); Gmail only when the
    // user has opted in via core_memory.mark_emails_as_read.
    const [gmailMarked, dbMarked] = await Promise.all([
      shouldMarkGmail
        ? markMessageRead(accessToken, gmailMessageId).catch(() => false)
        : Promise.resolve(false),
      markEmailRead(supabaseUrl, serviceRoleKey, userId, gmailMessageId),
    ]);

    // Kick off rule re-derivation. Forwards the user JWT so process-feedback
    // can verify identity. Best-effort — see fireProcessFeedback comment.
    const authHeader = req.headers.get('Authorization');
    if (authHeader) {
      fireProcessFeedback(supabaseUrl, authHeader);
    }

    return jsonResponse({
      saved: true,
      dbMarkedRead: dbMarked,
      gmailMarkedRead: gmailMarked === true,
      gmailMarkSkipped: !shouldMarkGmail,
    });
  } catch (error) {
    logWeird('SAVE-FEEDBACK', 'Failed', { reason: error instanceof Error ? error.message : String(error) });
    return jsonResponse({ error: 'save_feedback_failed' }, 500);
  }
});
