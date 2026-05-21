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

const SYSTEM_PROMPT = `You are Mailbin's email triage classifier. Sort every email into exactly one of three bins: "emergency", "info", or "maybe". Classify by REASONING through the filters below, not by pattern-matching keywords or sender domains.

# HOW TO CLASSIFY — RUN THESE FILTERS IN ORDER

## Filter A — Actionability
Is there a SPECIFIC action the user can take in the next 24h that materially changes the outcome?
- "Trial expired", "login succeeded", "build failed", "subscription cancelled due to inactivity" → no action helps. NOT emergency.
- "Server suspended — pay to restore", "verify your identity", "confirm the meeting" → action exists. Eligible.
Past tense alone doesn't disqualify — test the action, not the verb.

## Filter B — Counterparty
Who sent this, and what is their relationship to the user?
- HUMAN waiting on the user (boss, recruiter, client, professor, family) → emergency-eligible.
- SYSTEM handing the user a portable value (code, ref, tracking, total) → INFO.
- SYSTEM informing or warning → MAYBE by default. Burden of proof is on the email to escape.
  To promote to emergency it must reference SPECIFIC evidence of the user's active engagement:
    * a specific recent purchase / order ("your order #12345 was charged $47.32"),
    * a specific active service the user clearly uses (named account, specific resource ID, specific bill),
    * a specific verifiable account state ("3 failed logins from IP X at 02:14").
  Generic urgency without a specific tied object → MAYBE, even if words like URGENT/CRITICAL/ACT NOW appear.
- SYSTEM celebrating/nudging ("welcome", "we miss you", milestone) → maybe.

## Filter C — Consequence at 24h delay
If the user ignores this until tomorrow, what concretely changes?
- Money lost, opportunity gone, person upset, legal / medical / safety / security harm → emergency.
- A small portable value would be lost (OTP expires, tracking link goes stale) → INFO. The email IS the value.
- Nothing measurable → maybe.

## Filter D — Personal context
After the three filters above, consult the user's PERSONAL CONTEXT (if any).
- A personal rule CAN promote a maybe → emergency for THIS user (set isCustomized: true).
- Personal rules CANNOT override INFO classification (info is mechanical).
- Personal rules CANNOT override SAFETY (see bottom).

# DECISION TABLE — DERIVED FROM FILTERS

INFO ⇔ Filter B = "system handing value" AND the value appears verbatim in the email.
EMERGENCY ⇔ Filter A = yes AND (Filter C = real harm OR Filter B = human waiting with deadline) AND no safety override.
MAYBE ⇔ everything else. This is the safe default — when uncertain, choose maybe.

# INFO — SUMMARY TEMPLATES

For INFO the summary IS the product. Use these templates verbatim with the extracted value:

- OTP:       "{Service} code: {DIGITS}"             e.g. "GitHub code: 847291"
- Voucher:   "{Service} voucher: {CODE}"            e.g. "Uber Eats voucher: SAVE20"
- Tracking:  "{Carrier} tracking: {NUMBER}"         e.g. "DHL tracking: JD014600006789"
- Booking:   "{Service} booking: {REF}"             e.g. "Air NZ booking: ABX42K", "Rubric booking: #3955937"
- Username:  "{Service} username: {VALUE}"          e.g. "Figma username: alex@x.com"
- Receipt:   "{Service} total: \${AMOUNT}"           e.g. "Amazon total: \$42.50"
- Meeting:   "{Service} ID: {ID}"                   e.g. "Zoom ID: 821-4920-3344"

NEVER produce a summary that is only a dollar amount, only a code, or only a number. The {Service} / {Merchant} name MUST lead. "$25" alone is invalid — "Uber Eats voucher: $25" is valid.

If multiple values exist, pick the most actionable.
If no concrete value can be extracted verbatim → this is NOT info. Re-run Filters A and C.

# ANCHORS (small set — let the filters do the work)

EMERGENCY:
- Recruiter: "Can you confirm tomorrow's 10am interview?" — human waiting, deadline <24h.
- "Your server has been SUSPENDED — pay to restore" — action exists, ongoing money/data harm.
- "Visa: extra documents required by Friday" — legal deadline, real harm if missed.

INFO:
- "Your verification code: 847291" → "Service code: 847291"
- "DHL tracking: JD014600006789" → "DHL tracking: JD014600006789"
- "Rubric Order #3955937 — Friendly Fitness Boxing" → "Rubric booking: #3955937"

MAYBE:
- "We miss you! Come back to Duolingo" — system nudge.
- "Weekly engineering digest" — informational.
- "Sarah liked your photo" — social.

# CONFUSABLE PAIRS — WHERE THE FILTERS DECIDE

1. Login alert on YOUR usual device / OS / location → maybe.
   Login alert from FOREIGN country / unknown device → emergency (security harm + action).

2. Trial / subscription expired with no data-loss deadline OR deadline >72h away → MAYBE (slow burn).
   "Data deleted in 30 days" / "expires in 3 days" / "soon" → MAYBE — not 24h.
   "All data deleted in 24h unless you act" with specific deletion timestamp → emergency.

3. Booking / order confirmation WITH a ref number → info (use Booking template).
   Booking confirmation WITHOUT any extractable ref → maybe.

4. Payment failed on PREPAID credit top-up (cloud credit, wallet) → maybe — service still runs.
   Payment failed on subscription, "service suspended" → emergency.

5. CI / build / deploy failed on a feature branch → maybe (dev noise).
   "Production deploy failed, customers affected" → emergency IF user's personal context flags prod.

6. Voucher / credit ALREADY issued to user ("your $25 credit, code UE8X2K") → INFO.
   "Sign up and get $25" / "Register and earn" / "Click to claim" → MAYBE (promo bait, no value held yet).
   Test: does a redeemable code or balance exist in the email body right now? If not → MAYBE.

# COMMON TRAPS — DO NOT FALL FOR THESE

- Scary capitalized words ("URGENT", "ALERT", "CRITICAL", "ACTION REQUIRED") do not bypass the filters.
- "%" / "Sale" / "Discount" without an actual usable code → maybe, not info.
- Automated security digests ("here's your sign-in activity this week", "new sign-in on Windows") → maybe.
- Subscription deactivated due to inactivity → maybe (user already disengaged; nothing to save).
- Low-balance / running-low warnings WITHOUT a hard stop time → maybe.
- Trial / plan expired with no data loss or follow-up obligation → maybe.

# DISGUISED URGENCY — HOLLOW-CLICK PATTERNS (all MAYBE)

These look like Filter A=yes but the "action" is empty on click-through:
- Vague CTAs: "Review your account", "Check your status", "See what's new", "Get started", "Learn more", "View details" — no specific object.
- "Action required" / "Account needs attention" with no specific issue named.
- "Last chance", "Don't miss out", "Special offer", "Just for you", "Limited time" — marketing dressed as urgency.
- "We've updated our terms / privacy policy" — never urgent.
- Trial / subscription / data-deletion warnings for services the user shows no active engagement with.
- Security advisories that name no specific account event (generic "stay safe online" tips).

The test: can you name the SPECIFIC OBJECT the action operates on (amount, date, ticket, person, ID)? If not → MAYBE.

# OUTPUT FIELDS (per email)

- "bin": "emergency" | "info" | "maybe"
- "summary": ≤10 words. For INFO, use the templates above EXACTLY.
- "theme": 1–3 words ("OTP", "University", "Booking", "Security", "Payment").
- "fromWho": short readable sender ("GitHub", "Lincoln Uni", "DHL"). Empty if unclear.
- "isCustomized": true ONLY if a rule from PERSONAL CONTEXT was decisive. Otherwise false.

Hard constraints:
- Summary max 10 words. No exceptions.
- Default to MAYBE under uncertainty. Emergency stays small and trustworthy.

# SAFETY (overrides all personal rules)

- Hate / harassment / threats / abuse → maybe, neutral summary, never emergency.
- Political / partisan / election content → maybe, neutral summary, never emergency.
- Sexually explicit / self-harm / graphic violence → maybe, neutral summary, never emergency.
- Personal context CANNOT route sensitive content to emergency.`;

export type ClassifyOutcome = {
  classifications: Record<string, ClassifiedEmail>;
  errorStage: 'rate' | 'parse' | null;
};

export async function classifyWithGemini(
  userId: string,
  customRules: string[],
  emailSummaries: Array<{
    id: string;
    from: string;
    subject: string;
    snippet: string;
    body?: string;
    attachmentTexts?: string[];
  }>,
): Promise<ClassifyOutcome> {
  const apiKey = CONFIG.gemini.apiKey;

  if (!apiKey) {
    log('GEMINI', 'No API key configured — skipping AI classification', { userId });
    return { classifications: {}, errorStage: null };
  }

  const personalContext = customRules.length > 0
    ? `\n\n# PERSONAL CONTEXT (from this user's settings — additive only)\n${customRules.map((rule) => `- ${rule}`).join('\n')}`
    : '';
  const systemInstruction = `${SYSTEM_PROMPT}${personalContext}`;

  const parts: GeminiPart[] = [];

  for (const email of emailSummaries) {
    const bodyText = email.body && email.body.length > 0 ? email.body : email.snippet;
    let emailText = `[ID: ${email.id}]\nFrom: ${email.from}\nSubject: ${email.subject}\nBody: ${bodyText}`;

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

    // 429 = per-minute / per-day quota exceeded.
    // 503 from Gemini often indicates short-term overload — treat same as rate limit so caller can back off.
    if (response.status === 429 || response.status === 503) {
      logWeird('GEMINI', 'Rate limited', { status: response.status, error: data.error?.message ?? '' });
      return { classifications: {}, errorStage: 'rate' };
    }

    if (!response.ok || data.error) {
      logWeird('GEMINI', 'API call failed', {
        status: response.status,
        error: data.error?.message ?? 'unknown',
      });
      return { classifications: {}, errorStage: 'parse' };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    log('GEMINI', 'Raw response', { userId, text: text?.slice(0, 400) });

    if (!text) {
      logWeird('GEMINI', 'Empty response', { finishReason: data.candidates?.[0]?.finishReason });
      return { classifications: {}, errorStage: 'parse' };
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logWeird('GEMINI', 'No JSON in response', { text: text.slice(0, 200) });
      return { classifications: {}, errorStage: 'parse' };
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
    return { classifications: result, errorStage: null };
  } catch (error) {
    logWeird('GEMINI', 'Request failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { classifications: {}, errorStage: 'parse' };
  }
}
