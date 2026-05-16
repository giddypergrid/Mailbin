$ErrorActionPreference = 'Stop'

$EnvFile = Join-Path $PSScriptRoot '.env'

if (-not (Test-Path $EnvFile)) {
  throw "Create $EnvFile from supabase/.env.example first."
}

Write-Host 'Uploading Supabase secrets...' -ForegroundColor Cyan
npx supabase secrets set --env-file $EnvFile

Write-Host 'Pushing database migrations...' -ForegroundColor Cyan
npx supabase db push

Write-Host 'Deploying Supabase functions...' -ForegroundColor Cyan
npx supabase functions deploy gmail-oauth-start
npx supabase functions deploy gmail-oauth-callback
npx supabase functions deploy gmail-mails
npx supabase functions deploy gmail-connection-status
npx supabase functions deploy core-memory
npx supabase functions deploy gmail-sync

Write-Host ''
Write-Host 'Supabase setup complete.' -ForegroundColor Green
