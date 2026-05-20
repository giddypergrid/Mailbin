import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { log, logWeird } from '../_shared/logger.ts';
import { fetchCoreMemory, markFeedbackProcessed, fetchUnprocessedFeedback } from '../_shared/db.ts';
import { CONFIG } from '../_shared/config.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message: string };
};

const MEMORY_MAX_CHARS = CONFIG.coreMemory.maxLength;

function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as Record<string, unknown>; } catch { return null; }
}

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const supabaseUrl = requireEnv('MAILBIN_SUPABASE_URL');
    const serviceRoleKey = requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY');
    const geminiApiKey = requireEnv('GEMINI_API_KEY');
    const userId = await verifyJwt(req);
    if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);

    const coreMemory = await fetchCoreMemory(supabaseUrl, serviceRoleKey, userId);
    if (!coreMemory) return jsonResponse({ error: 'No core memory' }, 400);

    const feedbackList = await fetchUnprocessedFeedback(supabaseUrl, serviceRoleKey, userId);
    if (feedbackList.length === 0) {
      return jsonResponse({ processed: 0, message: 'No unprocessed feedback' });
    }

    const existingRules = coreMemory.custom_rules ?? [];

    const feedbackLines = feedbackList.map((f) =>
      `[${f.created_at?.slice(0, 10) ?? '?'}] Message: ${f.gmail_message_id.slice(0, 8)}... Feedback: "${f.feedback_text}"`
    ).join('\n');

    const prompt = `You are augmenting a user's email classification memory.
Current user rules (each rule is a "keyword/phrase → bin" mapping):
${existingRules.map((r: string) => `- ${r}`).join('\n') || '(none)'}

Recent feedback the user gave on specific emails (this tells you what they WANT):
${feedbackLines}

Task: Rewrite the user rules to incorporate their feedback preferences.
- Only adjust classification logic and summary style preferences.
- Preserve the original intent where feedback doesn't contradict it.
- Neutralize any bizarre, contradictory, or nonsensical feedback entries.
- Keep each rule under 30 words.
- Output NO MORE than 5 rules.

Return ONLY a JSON object:
{
  "rules": ["rule 1", "rule 2", ...]
}`;

    log('PROCESS-FEEDBACK', 'Sending to Gemini', { userId, feedbackCount: feedbackList.length, existingRuleCount: existingRules.length });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.gemini.model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: 'You augment user email classification rules based on feedback. Be conservative — only adjust rules when feedback clearly indicates a preference. Neutralize nonsense.' }],
          },
          contents: [{ parts: [{ text: prompt }] }],
        }),
      },
    );

    const data = await response.json() as GeminiResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      logWeird('PROCESS-FEEDBACK', 'Gemini returned empty', { finishReason: data.candidates?.[0] });
      return jsonResponse({ error: 'gemini_empty' }, 500);
    }

    const json = extractJson(text);
    if (!json || !Array.isArray(json.rules)) {
      logWeird('PROCESS-FEEDBACK', 'Failed to parse Gemini output', { text: text.slice(0, 200) });
      return jsonResponse({ error: 'gemini_parse_failed' }, 500);
    }

    let newRules = json.rules as string[];
    newRules = newRules.slice(0, 5);

    const payload = JSON.stringify({ custom_rules: newRules });
    if (payload.length > MEMORY_MAX_CHARS) {
      logWeird('PROCESS-FEEDBACK', 'New memory exceeds limit, truncating', { length: payload.length, max: MEMORY_MAX_CHARS });
      newRules = newRules.slice(0, Math.max(1, Math.floor(5 * MEMORY_MAX_CHARS / payload.length)));
    }

    const updateResponse = await fetch(
      `${supabaseUrl}/rest/v1/core_memory?user_id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ custom_rules: newRules }),
      },
    );

    if (!updateResponse.ok) {
      logWeird('PROCESS-FEEDBACK', 'Memory update failed', { status: updateResponse.status });
      return jsonResponse({ error: 'memory_update_failed' }, 500);
    }

    const feedbackIds = feedbackList.map((f) => f.id);
    await markFeedbackProcessed(supabaseUrl, serviceRoleKey, userId, feedbackIds);

    log('PROCESS-FEEDBACK', 'Complete', { userId, feedbackProcessed: feedbackList.length, newRuleCount: newRules.length });
    return jsonResponse({ processed: feedbackList.length, newRuleCount: newRules.length });
  } catch (error) {
    logWeird('PROCESS-FEEDBACK', 'Failed', { reason: error instanceof Error ? error.message : String(error) });
    return jsonResponse({ error: 'process_feedback_failed' }, 500);
  }
});
