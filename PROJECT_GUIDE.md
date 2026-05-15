# Mailbin Project Guide

This guide explains how the Mailbin prototype is organised, how the frontend talks to Supabase, how the Supabase setup command works, and what every key or secret is for.

## Big picture

Mailbin currently has two main parts:

```txt
frontend/   The React + Vite browser app that the user sees
supabase/   The backend: Edge Functions, OAuth callback code, and database migrations
```

The important rule is:

```txt
Frontend = public browser code
Supabase = backend trusted code
```

Anything sensitive must stay out of the frontend. The browser can see frontend code and frontend environment variables, so frontend values must only be public-safe values.

## Current project tree

```txt
Mailbin/
  frontend/
    src/
      App.tsx
      styles.css
      data/
      types.ts
      vite-env.d.ts
    assets/
    index.html
    package.json
    package-lock.json
    .env
    .env.example
    vite.config.ts
    tsconfig.json

  supabase/
    config.toml
    setup.sh
    setup.ps1
    migrations/
      20260512000000_create_gmail_connections.sql
    functions/
      _shared/
        cors.ts
      gmail-oauth-start/
        index.ts
      gmail-oauth-callback/
        index.ts
      gmail-mails/
        index.ts
      gmail-connection-status/
        index.ts
    .env.example


  package.json
  README.md
  PROJECT_GUIDE.md
```

## What the frontend does

The frontend lives in `frontend/`.

It is a React + TypeScript + Vite app. Its main file is:

```txt
frontend/src/App.tsx
```

Main frontend responsibilities:

- Shows the Mailbin UI.
- Shows the three bins.
- Lets you connect Gmail.
- Checks whether Supabase is reachable.
- Checks whether Gmail is already connected.
- Loads read-only Gmail messages into the Emergency bin.
- Does not store Google secrets.
- Does not directly talk to Google OAuth token endpoints.
- Does not directly use the Supabase service role key.

### Frontend local env file

The frontend uses:

```txt
frontend/.env
```

Create it from:

```txt
frontend/.env.example
```

It contains public frontend-safe values:

```txt
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
VITE_SUPABASE_FUNCTIONS_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1
```

### Why frontend variables start with `VITE_`

Vite only exposes environment variables to browser code if they start with:

```txt
VITE_
```

That is intentional. It makes it harder to accidentally expose private server-only secrets.

### Frontend variables explained

#### `VITE_SUPABASE_URL`

Example:

```txt
VITE_SUPABASE_URL=https://ghsrkpghruvhibqjuymr.supabase.co
```

What it is for:

- Public URL of your Supabase project.
- Used by the frontend to check Supabase connection.

Safe in frontend?

```txt
Yes
```

This is public project information.

#### `VITE_SUPABASE_ANON_KEY`

What it is for:

- Public Supabase anonymous key.
- Intended to be used in browsers.
- Limited by Supabase Row Level Security policies.

Safe in frontend?

```txt
Yes, if RLS is configured properly
```

This is not the same as the service role key.

#### `VITE_SUPABASE_FUNCTIONS_URL`

Example:

```txt
VITE_SUPABASE_FUNCTIONS_URL=https://ghsrkpghruvhibqjuymr.supabase.co/functions/v1
```

What it is for:

- Base URL for calling Supabase Edge Functions from the frontend.
- The app uses it to call functions like:

```txt
gmail-oauth-start
gmail-mails
gmail-connection-status
```

Safe in frontend?

```txt
Yes
```

It is just a URL.

## What Supabase does

Supabase is the backend for this prototype.

It handles:

- Google OAuth redirect start.
- Google OAuth callback.
- Secure Google token exchange.
- Storing Gmail tokens in Postgres.
- Reading Gmail messages using stored tokens.
- Checking whether Gmail is connected.

The Supabase project ref is:

```txt
ghsrkpghruvhibqjuymr
```

The Supabase project URL is:

```txt
https://ghsrkpghruvhibqjuymr.supabase.co
```

The Supabase functions base URL is:

```txt
https://ghsrkpghruvhibqjuymr.supabase.co/functions/v1
```

## Supabase Edge Functions

### `gmail-oauth-start`

Path:

```txt
supabase/functions/gmail-oauth-start/index.ts
```

What it does:

- Starts the Google OAuth flow.
- Builds the Google consent URL.
- Requests Gmail read-only permission.
- Creates a temporary OAuth `state` value.
- Stores that state in a secure cookie.
- Redirects the browser to Google.

Why it exists:

- The frontend should not build sensitive OAuth logic by itself.
- This function keeps the OAuth flow controlled on the backend.

### `gmail-oauth-callback`

Path:

```txt
supabase/functions/gmail-oauth-callback/index.ts
```

What it does:

- Receives the OAuth callback from Google.
- Checks the OAuth `state` to reduce CSRF risk.
- Exchanges the OAuth `code` for Google tokens.
- Gets the user's Gmail email address.
- Stores the Gmail connection in the `gmail_connections` table.
- Redirects back to the frontend.

Current redirect back to local frontend:

```txt
http://127.0.0.1:5174/?gmail=connected
```

That comes from the Supabase secret:

```txt
FRONTEND_URL
```

### `gmail-mails`

Path:

```txt
supabase/functions/gmail-mails/index.ts
```

What it does:

- Reads the latest Gmail connection from Supabase.
- Uses the stored Google access token.
- Refreshes the access token if it is close to expiring.
- Calls the Gmail API.
- Returns recent inbox messages to the frontend.

Important safety detail:

```txt
It reads Gmail only. It does not archive, delete, send, or modify email.
```

Current frontend usage:

```txt
GET /gmail-mails?limit=50
```

### `gmail-connection-status`

Path:

```txt
supabase/functions/gmail-connection-status/index.ts
```

What it does:

- Checks if a Gmail connection exists in the database.
- Returns whether Gmail is connected.

Example response:

```json
{"connected": true}
```

Why it exists:

- Prevents the frontend from asking you to connect Gmail every time.
- Lets the button show `Open Gmail bin` when already connected.

## Database

The migration lives here:

```txt
supabase/migrations/20260512000000_create_gmail_connections.sql
```

It creates the table:

```txt
gmail_connections
```

That table stores:

- Gmail account email.
- Google access token.
- Google refresh token.
- Token type.
- Granted scopes.
- Expiry time.
- Update time.

This table is backend-sensitive because it contains tokens.

## OAuth flow step by step

### 1. User clicks Connect Gmail

The frontend sends the browser to:

```txt
https://ghsrkpghruvhibqjuymr.supabase.co/functions/v1/gmail-oauth-start
```

### 2. Supabase redirects to Google

`gmail-oauth-start` redirects the user to Google's OAuth consent page.

Google asks the user to approve Gmail read-only access.

### 3. Google redirects back to Supabase

Google sends the user back to:

```txt
https://ghsrkpghruvhibqjuymr.supabase.co/functions/v1/gmail-oauth-callback
```

This redirect URI must be registered in Google Cloud.

### 4. Supabase exchanges the code

`gmail-oauth-callback` sends the code to Google from the backend.

This is where the Google client secret is used.

The frontend never sees the Google client secret.

### 5. Supabase stores tokens

The callback stores the connection in:

```txt
gmail_connections
```

### 6. Supabase redirects back to frontend

The callback redirects to:

```txt
http://127.0.0.1:5174/?gmail=connected
```

### 7. Frontend loads Gmail messages

When Emergency is opened, frontend calls:

```txt
https://ghsrkpghruvhibqjuymr.supabase.co/functions/v1/gmail-mails?limit=50
```

The backend reads Gmail and returns messages.

## Google Cloud configuration

In Google Cloud Console, your OAuth client should be a:

```txt
Web application
```

The authorised redirect URI must include:

```txt
https://ghsrkpghruvhibqjuymr.supabase.co/functions/v1/gmail-oauth-callback
```

For local testing, if your Google OAuth app is in Testing mode, add your Gmail account as a test user.

In the new Google UI this may be under:

```txt
Google Auth Platform Ã¢â€?Audience Ã¢â€?Test users
```

## Local commands

The root `package.json` contains shortcut commands so you can run everything from the project root.

### Install frontend dependencies

```powershell
npm run setup
```

What it runs:

```txt
npm --prefix frontend install
```

Meaning:

- Install packages inside `frontend/`.
- Keep frontend dependencies separate from the root.

### Start frontend dev server

```powershell
npm run dev
```

What it runs:

```txt
npm --prefix frontend run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Meaning:

- Start Vite from the `frontend/` folder.
- Serve on `127.0.0.1`.
- Use port `5174`.
- Fail if that port is already occupied.

Open:

```txt
http://127.0.0.1:5174/
```

### Build frontend

```powershell
npm run build
```

What it runs:

```txt
npm --prefix frontend run build
```

Meaning:

- Builds only the frontend app.
- Output goes to `frontend/dist/`.

### Preview production frontend build

```powershell
npm run preview
```

What it runs:

```txt
npm --prefix frontend run preview -- --host 127.0.0.1 --port 4173
```

Meaning:

- Serves the built frontend from `frontend/dist/`.

### Full Supabase setup

```powershell
npm run supabase:setup
```

What it runs:

```txt
sh ./supabase/setup.sh
```

Meaning:

- Uploads Supabase secrets from `supabase/.env`.
- Pushes database migrations.
- Deploys all Supabase functions.

If `sh` is not available in your Windows terminal, use:

```powershell
npm run supabase:setup:ps
```

### Set Supabase secrets

```powershell
npm run supabase:secrets
```

What it runs:

```txt
npx supabase secrets set --env-file ./supabase/.env
```

Meaning:

- Reads local secrets from `supabase/.env`.
- Sends them to Supabase Edge Function secrets using Supabase CLI.
- Does not commit secrets to git.

### Push database migrations

```powershell
npm run supabase:db:push
```

What it runs:

```txt
npx supabase db push
```

Meaning:

- Pushes SQL migrations from `supabase/migrations/` to the linked remote Supabase database.

### Deploy all Supabase functions

```powershell
npm run supabase:functions:deploy
```

What it deploys:

```txt
gmail-oauth-start
gmail-oauth-callback
gmail-mails
gmail-connection-status
```

Meaning:

- Uploads Edge Function code in `supabase/functions/` to Supabase.

## Local secret files

### Frontend env file

Real local file:

```txt
frontend/.env
```

Template file:

```txt
frontend/.env.example
```

Used by:

```txt
Vite frontend
```

Can contain only public-safe browser values.

### Supabase secret env file

Real local file:

```txt
supabase/.env
```

Template file:

```txt
supabase/.env.example
```

Used by:

```txt
supabase/setup.ps1
```

Contains sensitive backend secrets.

Do not commit it.

## Supabase backend secrets explained

These values are read by Supabase Edge Functions at runtime.

They are configured by running:

```powershell
npm run supabase:secrets
```

### `GOOGLE_CLIENT_ID`

What it is:

- The public ID for your Google OAuth Web Client.

Where to find it:

```txt
Google Cloud Console Ã¢â€?APIs & Services Ã¢â€?Credentials Ã¢â€?OAuth 2.0 Client IDs
```

Used by:

- `gmail-oauth-start`
- `gmail-oauth-callback`
- `gmail-mails` when refreshing tokens

Secret?

```txt
Not highly secret, but keep it in backend config for consistency.
```

### `GOOGLE_CLIENT_SECRET`

What it is:

- Private secret for your Google OAuth Web Client.

Where to find it:

```txt
Google Cloud Console Ã¢â€?APIs & Services Ã¢â€?Credentials Ã¢â€?your Web OAuth client
```

Used by:

- `gmail-oauth-callback` to exchange auth code for tokens.
- `gmail-mails` to refresh access tokens.

Secret?

```txt
Yes. Never put this in frontend code.
```

If leaked:

- Rotate/reset it in Google Cloud.
- Update `supabase/.env`.
- Run `npm run supabase:secrets` again.

### `GOOGLE_REDIRECT_URI`

Current value:

```txt
https://ghsrkpghruvhibqjuymr.supabase.co/functions/v1/gmail-oauth-callback
```

What it is:

- The URL Google redirects back to after OAuth consent.

Used by:

- `gmail-oauth-start`
- `gmail-oauth-callback`

Secret?

```txt
No
```

But it must exactly match the redirect URI in Google Cloud.

### `FRONTEND_URL`

Current local value:

```txt
http://127.0.0.1:5174
```

What it is:

- Where Supabase redirects the user after OAuth finishes.

Used by:

- `gmail-oauth-callback`

Secret?

```txt
No
```

For production, change it to your deployed frontend URL, for example:

```txt
https://your-mailbin-site.com
```

Then run:

```powershell
npm run supabase:secrets
```

### `MAILBIN_SUPABASE_URL`

Current value:

```txt
https://ghsrkpghruvhibqjuymr.supabase.co
```

What it is:

- Supabase project URL used by Edge Functions to call Supabase REST APIs.

Used by:

- `gmail-oauth-callback`
- `gmail-mails`
- `gmail-connection-status`

Secret?

```txt
No, but it is backend config.
```

Why not named `SUPABASE_URL`?

Supabase CLI blocks custom secret names starting with:

```txt
SUPABASE_
```

So the project uses:

```txt
MAILBIN_SUPABASE_URL
```

### `MAILBIN_SUPABASE_SERVICE_ROLE_KEY`

What it is:

- Supabase service role key.
- Powerful backend-only key that bypasses Row Level Security.

Used by:

- `gmail-oauth-callback` to save Gmail tokens.
- `gmail-mails` to read stored Gmail tokens.
- `gmail-connection-status` to check existing Gmail connection.

Secret?

```txt
Yes. Very sensitive.
```

Never put this in:

- Frontend code.
- `frontend/.env`.
- GitHub.
- Screenshots.
- Public logs.

If leaked:

- Rotate it in Supabase if possible.
- Update `supabase/.env`.
- Run `npm run supabase:secrets` again.

Why not named `SUPABASE_SERVICE_ROLE_KEY`?

Supabase CLI blocks custom secret names starting with:

```txt
SUPABASE_
```

So the project uses:

```txt
MAILBIN_SUPABASE_SERVICE_ROLE_KEY
```

## Which values are safe to expose?

### Safe in frontend

```txt
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_SUPABASE_FUNCTIONS_URL
```

These are public browser-side values.

### Backend only

```txt
GOOGLE_CLIENT_SECRET
MAILBIN_SUPABASE_SERVICE_ROLE_KEY
```

These must never be exposed in the frontend.

### Not secret but backend config

```txt
GOOGLE_CLIENT_ID
GOOGLE_REDIRECT_URI
FRONTEND_URL
MAILBIN_SUPABASE_URL
```

These are not as sensitive, but they are used by backend functions.

## Frontend `.env` vs Supabase `.env`

They are both environment files, but they live in different folders and are used for different things.

### `supabase/.env`

In this project:

```txt
supabase/.env
```

means backend/Supabase setup values.

It contains private backend secrets like:

```txt
GOOGLE_CLIENT_SECRET
MAILBIN_SUPABASE_SERVICE_ROLE_KEY
```

It is read by:

```txt
npm run supabase:secrets
npm run supabase:setup
```

It should not be committed.

### `frontend/.env`

In this project:

```txt
frontend/.env
```

means frontend development values.

It contains public browser-safe Vite values like:

```txt
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_SUPABASE_FUNCTIONS_URL
```

It is read by Vite when you run:

```txt
npm run dev
```

It should not be committed because it is environment config, even though the current values are mostly public-safe.

### Simple rule

```txt
supabase/.env        Backend secrets for cloud functions
frontend/.env        Frontend config for Vite
```

## Why secrets are split into two places

There are two different env systems:

### 1. Frontend env

File:

```txt
frontend/.env
```

Loaded by:

```txt
Vite dev server and Vite build
```

Visible to:

```txt
Browser frontend code
```

### 2. Supabase Edge Function secrets

Local source file:

```txt
supabase/.env
```

Uploaded by:

```txt
supabase/setup.ps1
```

Loaded by:

```txt
Supabase Edge Functions in the cloud
```

Visible to:

```txt
Backend function runtime only
```

This separation is important because frontend variables are not private.

## Day-to-day development workflow

### Start local frontend

```powershell
npm run dev
```

Open:

```txt
http://127.0.0.1:5174/
```

### If frontend env changes

Restart Vite:

```powershell
npm run dev
```

### If Supabase function code changes

Deploy functions:

```powershell
npm run supabase:functions:deploy
```

### If Supabase secrets change

Update:

```txt
supabase/.env
```

Then run:

```powershell
npm run supabase:secrets
```

### If database schema changes

Add a migration in:

```txt
supabase/migrations/
```

Then run:

```powershell
npm run supabase:db:push
```

## Current limitations

This is still a prototype.

Current limitations:

- No real user accounts inside Mailbin yet.
- Gmail connection status currently checks whether any Gmail connection exists.
- Emergency bin shows recent Gmail inbox messages read-only.
- No AI classification yet.
- No unsubscribe/archive/delete actions yet.
- No production hosted frontend yet.

## Production notes for later

Before real users:

- Deploy the frontend to a real domain.
- Change `FRONTEND_URL` from local `127.0.0.1` to production URL.
- Update Google OAuth consent app.
- Add privacy policy and terms.
- Complete Google verification for Gmail scopes.
- Replace prototype connection model with real authenticated users.
- Ensure per-user Gmail connections, not one shared latest connection.
- Review database RLS policies.
- Rotate any secrets that were exposed during development.

## Quick command reference

```powershell
npm run setup
npm run dev
npm run build
npm run preview
npm run supabase:secrets
npm run supabase:db:push
npm run supabase:functions:deploy
```
