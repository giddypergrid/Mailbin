alter table public.core_memory drop column memory_text;
alter table public.core_memory add column custom_rules jsonb not null default '[]'::jsonb;
