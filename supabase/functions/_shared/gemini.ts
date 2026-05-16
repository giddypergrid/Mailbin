import { log, logWeird } from './logger.ts';
import { CONFIG } from './config.ts';
import { type ClassifiedEmail } from './types.ts';

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

type GeminiRequest = {
  systemInstruction?: { parts: GeminiPart[] };
  contents: Array<{ role?: string; parts: GeminiPart[] }>;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message: string };
};

const getGeminiModel = () => CONFIG.gemini.model;


export async function classifyWithGemini(
  systemInstruction: string,
  emailSummaries: Array<{
    id: string;
    from: string;
    subject: string;
    snippet: string;
    attachmentTexts?: string[];
  }>,
  summaryMaxWords: number,
): Promise<Record<string, ClassifiedEmail>> {
  const apiKey = CONFIG.gemini.apiKey;

  if (!apiKey) {
    log('GEMINI', 'No API key configured — skipping AI classification');
    return {};
  }

  const parts: GeminiPart[] = [];

  for (const email of emailSummaries) {
    let emailText = `[ID: ${email.id}]\nFrom: ${email.from}\nSubject: ${email.subject}\nBody: ${email.snippet}`;

    if (email.attachmentTexts && email.attachmentTexts.length > 0) {
      emailText += '\nAttachments:\n' + email.attachmentTexts.join('\n---\n');
    }

    parts.push({ text: emailText });
  }

  parts.push({
    text: `For each email above:
1. Classify as "emergency", "info", or "maybe" based on system rules.
2. Write a 1-line summary (~${summaryMaxWords} words). May exceed only for urgent emergencies.
3. Theme: 1-3 word topic (e.g. "Payment", "Security", "Promo", "Work", "Social", "Account", "Shipping", "Trial Ending").
4. FromWho: extract a short human-readable sender name (e.g. "Google", "Temu", "RunPod", "Uber Eats", "Lincoln Uni"). Leave empty if unclear.

Return ONLY a JSON object:
{
  "email-id-1": { "bin": "emergency", "summary": "RunPod balance critically low", "theme": "Service Alert", "fromWho": "RunPod" }
}`,
  });

  const requestBody: GeminiRequest = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [{ parts }],
  };

  try {
    log('GEMINI', 'Sending classify+summarize request', {
      emailCount: emailSummaries.length,
      model: getGeminiModel(),
    });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${getGeminiModel()}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(requestBody),
      },
    );

    const data = await response.json() as GeminiResponse;

    if (!response.ok || data.error) {
      logWeird('GEMINI', 'API call failed', {
        status: response.status,
        error: data.error?.message ?? 'unknown',
      });
      return {};
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    log('GEMINI', 'Raw response', { text: text?.slice(0, 400) });

    if (!text) {
      logWeird('GEMINI', 'Empty response', { finishReason: data.candidates?.[0]?.finishReason });
      return {};
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logWeird('GEMINI', 'No JSON in response', { text: text.slice(0, 200) });
      return {};
    }

    const raw = JSON.parse(jsonMatch[0]) as Record<string, string | { bin?: string; summary?: string; theme?: string; fromWho?: string }>;
    const validBins = new Set(['emergency', 'info', 'maybe']);
    const result: Record<string, ClassifiedEmail> = {};

    for (const [id, value] of Object.entries(raw)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const bin = value.bin ?? '';

        if (validBins.has(bin)) {
          result[id] = {
            bin: bin as 'emergency' | 'info' | 'maybe',
            summary: value.summary ?? '',
            theme: value.theme ?? '',
            fromWho: value.fromWho ?? '',
          };
        }
      } else if (typeof value === 'string' && validBins.has(value)) {
        result[id] = { bin: value as 'emergency' | 'info' | 'maybe', summary: '', theme: '', fromWho: '' };
      }
    }

    log('GEMINI', 'Classify+summarize complete', {
      classified: Object.keys(result).length,
      sampleId: Object.keys(result)[0],
      sampleResult: result[Object.keys(result)[0]],
    });
    return result;
  } catch (error) {
    logWeird('GEMINI', 'Request failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
