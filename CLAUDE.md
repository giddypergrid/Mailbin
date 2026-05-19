# Mailbin — Project Context

Email triage app: Gmail emails sorted into Emergency / Info / Maybe bins by Gemini, with concise summaries.
- **Emergency** = "anxious-morning bin" — life/career/money/safety/deadline stuff. Underfilled by design.
- **Info** = "quick utility drawer" — OTPs, tracking numbers, voucher codes, booking refs. Summary extracts the value verbatim (e.g. `GitHub code: 847291`).
- **Maybe** = default catch-all — promos, newsletters, FYI, social.

Mobile-first React app, Capacitor-built APK for Android.

## Code Style
- **Variable naming:** No abbreviations. Every name must be the full word. `OauthState` not `state`, `expectedOauthState` not `expectedState`.

## Stack
React 19 + TypeScript + Vite 7 (frontend), Supabase Edge Functions / Deno (backend), Supabase Postgres (DB). No testing, no linting, no CI/CD.

## Project Structure
```
Mailbin/
├── frontend/                # React + Vite UI
│   ├── src/
│   │   ├── App.tsx          # All UI + logic
│   │   ├── types.ts         # BinId, MailItem, MailAttachment, CoreMemory
│   │   ├── styles.css       # All styling
│   │   ├── logger.ts        # Browser-side logging
│   │   ├── Dropdown.tsx     # Reusable dropdown
│   │   └── data/mail.ts     # Bin configs only
│   └── .env                 # VITE_SUPABASE_URL, ANON_KEY, FUNCTIONS_URL
├── supabase/
│   ├── functions/
│   │   ├── gmail-oauth-start/      # Redirects to Google consent
│   │   ├── gmail-oauth-callback/   # Exchanges code for tokens, saves to DB
│   │   ├── gmail-mails/            # Reads classified emails from gmail_emails DB table
│   │   ├── gmail-sync/             # Background sync: fetches Gmail → classify → store in DB
│   │   ├── gmail-connection-status/# { connected: true/false }
│   │   ├── core-memory/            # User preferences (GET auto-creates, PUT upserts)
│   │   └── _shared/                # cors, http, auth, logger, gemini, attachment-processor
│   ├── migrations/                 # gmail_connections, +user_id, core_memory, attachment size kb, gmail_emails
│   ├── .env                        # Secrets (GOOGLE_CLIENT_SECRET, GEMINI_API_KEY, etc.)
│   ├── setup.ps1                   # Upload secrets + push DB + deploy all functions
│   └── config.toml                 # verify_jwt = false on all functions
├── package.json                    # Script proxy only
├── start.ps1                       # vite dev --open on port 5174
└── .gitignore
```

## Auto-deploy Rule
After editing ANY Edge Function file (under `supabase/functions/`), auto-deploy it immediately without asking:
`npx supabase functions deploy <name> --project-ref ghsrkpghruvhibqjuymr`

## Commands
| Command | What |
|---|---|
| `npm run setup` | `npm --prefix frontend install` |
| `npm run dev` | Vite dev at `http://127.0.0.1:5174/` |
| `npm run build` | `tsc -b && vite build` → `frontend/dist/` |
| `npm run supabase:setup` | Uses `setup.ps1` on Windows |
| `npm run supabase:secrets` | Uploads `supabase/.env` secrets |
| `npm run supabase:db:push` | Pushes migrations to remote |
| `npm run supabase:functions:deploy` | Deploys all edge functions |

## Environment Variables
All stored in `supabase/.env` and uploaded via `npx supabase secrets set`.

| Var | Default | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | required | Google OAuth client |
| `GOOGLE_CLIENT_SECRET` | required | OAuth token exchange / refresh |
| `GOOGLE_REDIRECT_URI` | required | OAuth callback URL |
| `FRONTEND_URL` | required | Where to redirect after OAuth |
| `MAILBIN_SUPABASE_URL` | required | Supabase project URL |
| `MAILBIN_SUPABASE_SERVICE_ROLE_KEY` | required | Service role key for DB access |
| `MAILBIN_JWT_PUBLIC_KEY` | required | JWT verification for per-user auth |
| `GEMINI_API_KEY` | required for AI | Gemini API key |
| `MAILBIN_LOG_LEVEL` | `info` | Set to `silent` to disable logs |
| `MAILBIN_FETCH_LIMIT` | `10` | Emails fetched per page |
| `MAILBIN_FETCH_BATCH_SIZE` | `5` | Concurrent Gmail detail requests |
| `MAILBIN_CLASSIFY_BATCH_SIZE` | `15` | Emails per Gemini classify call |
| `MAILBIN_FETCH_BATCH_DELAY_MS` | `300` | Delay between 429-safe batches |
| `MAILBIN_GEMINI_MODEL` | `gemini-2.5-flash-lite` | Gemini model to call |
| `MAILBIN_DEFAULT_CORE_MEMORY` | see core-memory/index.ts | Default classification rules text |
| `MAILBIN_CORE_MEMORY_MAX_LENGTH` | `5000` | Max chars for memory_text |
| `MAILBIN_ATTACHMENT_KB_MIN` | `1` | Minimum attachment size limit |
| `MAILBIN_ATTACHMENT_KB_MAX` | `1000` | Maximum attachment size limit |
| `MAILBIN_ATTACHMENT_KB_DEFAULT` | `100` | Default attachment size |
| `MAILBIN_SYNC_BASELINE_MAX` | `50` | Max emails on first-connect baseline |
| `MAILBIN_SYNC_INCREMENTAL_MAX` | `200` | Max emails per incremental sync (0 = no cap) |
| `MAILBIN_SYNC_RETRY_DELAY_MS` | `5000` | Wait after 429 rate limit |
| `MAILBIN_SYNC_MAX_RETRIES` | `3` | Max retries on rate limit |

## Architecture
- **Frontend never sees secrets** — OAuth token exchange happens in Edge Functions (Deno), not the browser.
- **OAuth flow:** Click Connect → redirect to Google consent → callback exchanges code for tokens → stores in `gmail_connections` → redirects back with `?gmail=connected`.
- **DB tables:** `gmail_connections` (OAuth tokens), `core_memory` (preferences), `gmail_emails` (processed + classified emails).
- **Sync architecture:** Background `gmail-sync` fetches Gmail → dedup by message_id → Gemini classify → store in `gmail_emails`. Frontend reads from DB only. No Gmail API calls during page load.
- **Sync flow:** Baseline 50 unread on first connect, then incremental 200 per sync. "Collect IDs first, then process" pattern avoids cursor pagination gap.
- **No user accounts yet** — single latest connection, no per-user auth. RLS enabled but no policies (service role key bypasses it).

## Critical Gotchas
1. **`supabase/.env` contains live secrets** — must stay gitignored.
2. **No `.env.example`** — env vars live only in live .env files.
3. **Secret naming:** Supabase CLI blocks `SUPABASE_` prefix → use `MAILBIN_` instead.
4. **All functions have `verify_jwt = false`** — endpoints are open. Intentional for prototype.
5. **Port 5174** hardcoded — FRONTEND_URL and OAuth callback URI must match exactly.
6. **Google callback URI** must be registered exactly: `https://ghsrkpghruvhibqjuymr.supabase.co/functions/v1/gmail-oauth-callback`
7. **No local Supabase** — all DB/function operations go to cloud project directly.
8. **`setup.ps1` only** — no setup.sh.
9. **App icon injected by CI** (not committed to native code) — source files: `frontend/resources/icon.png`, `icon-foreground.png` at 1024×1024.
10. **Two-level batching in `gmail-sync`:** `MAILBIN_FETCH_BATCH_SIZE` (5) = concurrent Gmail fetches, `MAILBIN_CLASSIFY_BATCH_SIZE` (15) = emails per Gemini call. Inflating fetch risks 429; inflating classify saves cost.

## Key Changes
- **2026-05-17:** Sync overhaul — oldest-first processing, fetch all IDs first then reverse. Rate limit retry (429/503, 3 retries, 5s delay). `last_synced_at` only advanced when fully caught up. Baseline 50 / incremental 200. Frontend: recursive sync loop, live progress, "N new emails" button.
- **2026-05-18:** Major UI redesign — unified beige background (#f5f0e8), compact cards (~4/screen), sleepy bin empty states with per-bin messages, "New Message" button replaces back-to-top.
- **2026-05-19:** Prompt + sync revamp. Bins now defined by user impact (Emergency = anxious-morning, Info = utility drawer). ~30 contrast examples inline. `core_memory.defaultRules` rewritten as additive personalization, seeded on new user. `maxRules` 5→10, `maxRuleLength` 20→200. Bug fixes: raw ISO `received_at`, `is_read` from Gmail `labelIds`, two-level batching, UTC date formatting, empty Gemini batch warning. Deleted stray `tets,ts`.

## Production Blockers
Not production-ready as of 2026-05-19. Suitable for personal alpha only.

1. `verify_jwt = false` on all edge functions — public URLs.
2. No Google OAuth verification — dev mode, restricted scopes need consent screen review.
3. No RLS policies — service role key on every function, query bug = cross-user leak.
4. Refresh tokens stored unencrypted in `gmail_connections.refresh_token`.
5. APK is `assembleDebug` — unsigned, can't go on Play Store.
6. `mark_emails_as_read: true` default silently modifies user's Gmail — should default OFF.
7. No error monitoring (Sentry/Logflare).
8. `VITE_SUPABASE_ANON_KEY` hardcoded in workflow yaml — should be a GitHub Secret.

## Future Work
- Interest-based routing: sender/topic allowlist to force Emergency bin (partially via personal rules, no UI yet)
- Unsubscribe / archive / delete actions
- Splash screen + adaptive monochrome icon for Android 13+
- Per-bin sound / notification preferences
