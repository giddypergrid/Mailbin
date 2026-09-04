# Mailbin

> **Status: paused since May 2026.** It works and it is worth reading for the classification design,
> but it is not deployed and I am not adding to it. Live work is
> [Fine Print](https://github.com/giddypergrid/nzfineprint-backend) and
> [NZ Bird Sound](https://github.com/giddypergrid/NZBirdSoundDatabase-AWS).

A Gmail triage app. It reads your Primary tab, has Gemini sort each email into one of a few bins by
what it needs from you, and you swipe through them. Android build via Capacitor.

## The part worth reading: the prompt is a filter chain, not examples

The first classifier prompt carried about 30 positive examples per bin. It pattern-matched surface
words. Anything containing "URGENT", "Suspicious login" or "low balance" landed in Emergency, so
Jira deactivation notices, RunPod balance warnings and GitHub Actions failures all piled in there
together.

The replacement asks four ordered questions instead:

```
  1. Actionability          does this need me to do something?
  2. Counterparty           who is asking, and do I have a relationship with them?
  3. Consequence at 24h     what actually happens if I ignore it until tomorrow?
  4. Personal context       does this touch something I am already dealing with?
```

Examples dropped to three anchors per bin, plus five confusable pairs where two emails look
identical on the surface and the filters separate them. That, and a "common traps" section, is what
made it stop over-reacting to alarming words.

## Two bugs that took a while

**Every bin stopped at exactly 20 emails.** Old scroll listener, new IntersectionObserver, every
Android build, always 20. The bug was in the backend query. The pagination cursor is an ISO
timestamp like `2026-05-26T06:33:02+00:00`, pasted raw into a PostgREST URL, and in a query string
`+` decodes to a space. PostgREST received `06:33:02 00:00`, returned `22007 invalid input syntax for
type timestamp`, and the fetch helper swallowed the 400 and returned an empty page with a null
cursor. One `encodeURIComponent` fixed it. Proven both ways: raw `+` gives HTTP 400, `%2B` gives 200.

**The classifier only ever saw the snippet.** Gmail's `snippet` is roughly 200 characters, so order
numbers, booking references and one-time codes sitting mid-body were invisible to Gemini. The fix
walks the Gmail payload, prefers `text/plain`, falls back to stripped HTML, and sends 2000 characters
per email.

## Rate limiting against a free tier

Gemini's free tier allows 10 requests per minute. A first sync classifies in batches of 50 so it fits
in a single call; incremental syncs use 30. A pacer tracks call timestamps within a trailing 60
seconds and sleeps rather than firing. On a 429 or 503 the sync marks itself rate limited and
deliberately does **not** advance `last_synced_at`, so the next run repeats the window instead of
skipping mail.

## Where to look

| File | Why |
|---|---|
| `supabase/functions/_shared/gemini.ts` | The system prompt, the four filters and the anchors |
| `supabase/functions/gmail-sync/index.ts` | Body extraction, batching, the rate-limit pacer |
| `frontend/src/db.ts` | The pagination cursor and the encoding fix |

## Known gaps

- Attachments are categorised but never decoded, so a PDF's contents cannot reach the classifier.
- `gmail-mails` returns `attachments: []` hardcoded.
- Non-initial fetch failures still surface as empty lists rather than errors.

---

React, TypeScript, Capacitor for Android, Supabase (Postgres, edge functions, auth), Gemini 2.5
Flash. Landing site is [Mainbin-Web](https://github.com/giddypergrid/Mainbin-Web).
