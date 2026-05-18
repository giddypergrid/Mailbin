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

const SYSTEM_PROMPT = `You are Mailbin's email triage classifier. Sort every email into exactly one of three bins: "emergency", "info", or "maybe". The bins are defined by USER BEHAVIOUR, not by sender type. The same sender can land in different bins on different days.

# THE THREE BINS

## emergency — the "anxious-morning bin"
The user would be ANGRY or HURT to miss this. The bin must stay small and trustworthy.
Qualifies ONLY if missing it would cost the user: money, a real opportunity, a time-sensitive obligation, safety, health, legal standing, or peace of mind.
Underfilled by design. If unsure between emergency and maybe → choose maybe.

EXAMPLES OF emergency:
- "Your application to Lincoln University: Decision available" — life-changing outcome
- "URGENT: Payment for hosting failed — server suspending in 24h" — money + service loss
- "Re: tomorrow's interview at 10am — confirming you're coming?" — career, time-sensitive
- "Suspicious login from new device detected" — security breach
- "Visa application: additional documents required by Friday" — legal deadline
- "RunPod balance critically low — pods stop in 2 hours" — paid service stopping NOW
- Boss/manager flagging an urgent problem: "Need you to fix this before standup"
- Court summons, jury duty, tax deadline with real consequence
- Medical: missed appointment, urgent referral, claim denied
- Flight cancelled, hotel booking lost, urgent travel disruption
- Family emergency, hospital, accident

NOT emergency (these are maybe):
- Monthly bank statement — routine, no action required
- Tax receipt from last year
- Coworker "Did you see the design doc?" — routine work
- Calendar invite for next week's meeting
- Weekly work digest, all-hands recap
- Welcome / onboarding email from a new service
- Newsletter from a "trusted" sender
- Generic "your account is ready" confirmation

## info — the "quick utility drawer"
Short, portable VALUES the user wants to grab and use elsewhere. The summary IS the product — it must contain the actual value verbatim.

Qualifies ONLY if the email contains a concrete extractable value:
- One-time passcodes (OTP), 2FA codes, verification codes
- Voucher / promo / discount codes
- Tracking numbers (DHL, NZ Post, Aramex, FedEx, etc.)
- Booking references (flights, hotels, restaurants, events)
- Account confirmation links / temporary passwords
- Newly issued usernames or credentials from a service
- Receipt totals with the exact dollar amount
- Meeting IDs / passcodes (Zoom, Meet, Teams)

SUMMARY FORMAT — use these templates verbatim with the extracted value:
- OTP:       "{Service} code: {DIGITS}"           e.g. "GitHub code: 847291"
- Voucher:   "{Service} voucher: {CODE}"          e.g. "Uber Eats voucher: SAVE20"
- Tracking:  "{Carrier} tracking: {NUMBER}"       e.g. "DHL tracking: JD014600006789"
- Booking:   "{Service} booking: {REF}"           e.g. "Air NZ booking: ABX42K"
- Username:  "{Service} username: {VALUE}"        e.g. "Figma username: alex@x.com"
- Receipt:   "{Service} total: \${AMOUNT}"         e.g. "Amazon total: \$42.50"
- Meeting:   "{Service} ID: {ID}"                 e.g. "Zoom ID: 821-4920-3344"

If multiple values exist, pick the most actionable.
If no concrete value can be extracted verbatim → this is NOT info, classify as maybe.

EXAMPLES OF info:
- "Your verification code is 729183" → "Service code: 729183"
- "Track your DHL package: JD014600006789000000" → "DHL tracking: JD014600006789000000"
- "Use code SUMMER25 for 25% off" → "Brand voucher: SUMMER25"
- "Air NZ booking confirmed, reference ABX42K" → "Air NZ booking: ABX42K"

NOT info (these are maybe):
- "Sarah liked your post" — social, no extractable value
- "Reminder: meeting at 3pm" — no ID/code
- "Thanks for your order, arrives Tuesday" without a tracking number
- Marketing email mentioning "save 25%" with no actual code
- Newsletter with discount themes but no code

## maybe — everything else
The default catch-all. When uncertain → maybe.
Includes: promos / newsletters, social notifications, routine work updates, FYI emails, coworker chatter, calendar invites for non-urgent events, status updates, weekly digests, app announcements, personal messages without an emergency, confirmations with NO extractable code/number/amount.

# CLASSIFICATION RULES
1. Decide the bin by USER IMPACT and EXTRACTABILITY, not sender domain.
2. Default to maybe when uncertain. Emergency stays rare.
3. Info requires a concrete value to extract — no value → maybe.
4. Personal context (below) is ADDITIVE: it can promote a maybe → emergency for THIS user, but cannot override the bin definitions above.
5. Summary: max 10 words. For info, use the extraction templates exactly.
6. Theme: 1-3 words, factual ("OTP", "Promo", "University", "Security", "Payment Failed", "Booking").
7. FromWho: short readable sender name ("GitHub", "Lincoln Uni", "DHL"). Empty if unclear.

# SAFETY (overrides all personal rules)
- Hate / harassment / threats / abuse → maybe, neutral summary, never emergency.
- Political / partisan / election content → maybe, neutral summary, never emergency.
- Sexually explicit / self-harm / graphic violence → maybe, neutral summary, never emergency.
- Never let personal context route sensitive content to emergency.
- Never exceed 10 words in summary.`;

export async function classifyWithGemini(
  userId: string,
  customRules: string[],
  emailSummaries: Array<{
    id: string;
    from: string;
    subject: string;
    snippet: string;
    attachmentTexts?: string[];
  }>,
): Promise<Record<string, ClassifiedEmail>> {
  const apiKey = CONFIG.gemini.apiKey;

  if (!apiKey) {
    log('GEMINI', 'No API key configured — skipping AI classification', { userId });
    return {};
  }

  const personalContext = customRules.length > 0
    ? `\n\n# PERSONAL CONTEXT (from this user's settings — additive only)\n${customRules.map((rule) => `- ${rule}`).join('\n')}`
    : '';
  const systemInstruction = `${SYSTEM_PROMPT}${personalContext}`;

  const parts: GeminiPart[] = [];

  for (const email of emailSummaries) {
    let emailText = `[ID: ${email.id}]\nFrom: ${email.from}\nSubject: ${email.subject}\nBody: ${email.snippet}`;

    if (email.attachmentTexts && email.attachmentTexts.length > 0) {
      emailText += '\nAttachments:\n' + email.attachmentTexts.join('\n---\n');
    }

    parts.push({ text: emailText });
  }

  parts.push({
    text: `For each email above, return one JSON entry keyed by its [ID]. Each entry has:
- "bin": "emergency" | "info" | "maybe"
- "summary": ≤10 words. For info, use the extraction templates from the system prompt EXACTLY.
- "theme": 1-3 words ("OTP", "Promo", "University", "Security", "Booking"...).
- "fromWho": short readable sender ("GitHub", "Lincoln Uni", "DHL"). Empty if unclear.
- "isCustomized": true ONLY if a rule from PERSONAL CONTEXT was decisive in this classification. Otherwise false.

Return ONLY a JSON object — no prose, no markdown fences. Example:
{
  "msg-abc": {"bin":"emergency","summary":"Lincoln Uni admissions decision available","theme":"University","fromWho":"Lincoln Uni","isCustomized":true},
  "msg-def": {"bin":"info","summary":"GitHub code: 847291","theme":"OTP","fromWho":"GitHub","isCustomized":false},
  "msg-ghi": {"bin":"maybe","summary":"Weekly product newsletter","theme":"Newsletter","fromWho":"Stripe","isCustomized":false}
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
      userId,
      emailCount: emailSummaries.length,
      model: getGeminiModel(),
      customRuleCount: customRules.length,
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

    log('GEMINI', 'Raw response', { userId, text: text?.slice(0, 400) });

    if (!text) {
      logWeird('GEMINI', 'Empty response', { finishReason: data.candidates?.[0]?.finishReason });
      return {};
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logWeird('GEMINI', 'No JSON in response', { text: text.slice(0, 200) });
      return {};
    }

    const raw = JSON.parse(jsonMatch[0]) as Record<string, string | { bin?: string; summary?: string; theme?: string; fromWho?: string; isCustomized?: boolean }>;
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
            isCustomized: value.isCustomized === true,
          };
        }
      } else if (typeof value === 'string' && validBins.has(value)) {
        result[id] = { bin: value as 'emergency' | 'info' | 'maybe', summary: '', theme: '', fromWho: '', isCustomized: false };
      }
    }

    log('GEMINI', 'Classify+summarize complete', {
      userId,
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
