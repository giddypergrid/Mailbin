-- Patch: old rows created before the MB->KB rename have value 2 (was 2 MB, now reads as 2 KB)
-- Fix by updating any row that still has the old value to 2048 KB (≈2 MB)
UPDATE public.core_memory
SET attachment_max_size_kb = 2048
WHERE attachment_max_size_kb = 2;
