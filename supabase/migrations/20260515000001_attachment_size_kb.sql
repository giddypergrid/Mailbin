alter table public.core_memory rename column attachment_max_size_mb to attachment_max_size_kb;
alter table public.core_memory alter column attachment_max_size_kb set default 100;
