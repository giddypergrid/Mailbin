create table if not exists public.gmail_connections (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  access_token text not null,
  refresh_token text,
  token_type text,
  scope text,
  expires_at timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gmail_connections enable row level security;
