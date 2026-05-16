create table if not exists public.gmail_emails (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  gmail_message_id text not null,
  thread_id text,
  from_name text not null default '',
  from_email text not null default '',
  subject text not null,
  summary text not null default '',
  received_at timestamptz,
  bin text not null default 'maybe',
  ai_theme text not null default '',
  ai_from_who text not null default '',
  has_attachments boolean not null default false,
  attachment_total_kb int not null default 0,
  synced_at timestamptz not null default now(),
  unique(user_id, gmail_message_id)
);

create index if not exists idx_gmail_emails_user_bin_received
  on public.gmail_emails(user_id, bin, received_at desc);

alter table public.gmail_emails enable row level security;

alter table public.gmail_connections add column if not exists last_synced_at timestamptz;
