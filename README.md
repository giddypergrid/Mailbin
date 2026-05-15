# Mailbin

For the full project walkthrough, Supabase explanation, local scripts, OAuth flow, and credentials guide, read:

```txt
PROJECT_GUIDE.md
```

## Folder structure

```txt
frontend/   React + Vite prototype UI
supabase/   Supabase Edge Functions and database migrations
```

## Local frontend

Create `frontend/.env` from `frontend/.env.example`, then run from the repo root:

```powershell
npm run setup
```

```powershell
npm run dev
```

Open:

```txt
http://127.0.0.1:5174/
```

## Build frontend

```powershell
npm run build
```

## Supabase helpers

Run full Supabase setup from `supabase/.env`:

```powershell
npm run supabase:setup
```

If your Windows terminal does not have `sh`, use:

```powershell
npm run supabase:setup:ps
```

Set only Supabase secrets from `supabase/.env`:

```powershell
npm run supabase:secrets
```

Push database migrations:

```powershell
npm run supabase:db:push
```

Deploy all functions:

```powershell
npm run supabase:functions:deploy
```
