create table if not exists public.core_memory (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  memory_text text not null default '',
  summary_max_words integer not null default 10,
  attachment_max_size_mb integer not null default 2,
  send_attachments_to_ai boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
