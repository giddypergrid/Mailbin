-- One-row table; PL/pgSQL function does atomic check-and-reserve with FOR UPDATE.
CREATE TABLE IF NOT EXISTS gemini_rate_window (
  id              INT PRIMARY KEY DEFAULT 1,
  call_timestamps TIMESTAMPTZ[] NOT NULL DEFAULT '{}'
);

INSERT INTO gemini_rate_window (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION reserve_gemini_slot(rpm_limit INT)
RETURNS TABLE(granted BOOLEAN, retry_after_ms INT)
LANGUAGE plpgsql AS $$
DECLARE
  current_timestamps  TIMESTAMPTZ[];
  pruned_timestamps   TIMESTAMPTZ[];
  oldest_in_window    TIMESTAMPTZ;
  wait_ms             INT;
BEGIN
  SELECT call_timestamps INTO current_timestamps
  FROM gemini_rate_window WHERE id = 1 FOR UPDATE;

  SELECT COALESCE(array_agg(ts ORDER BY ts), '{}')
  INTO pruned_timestamps
  FROM unnest(current_timestamps) AS ts
  WHERE ts > NOW() - INTERVAL '60 seconds';

  IF array_length(pruned_timestamps, 1) IS NULL
     OR array_length(pruned_timestamps, 1) < rpm_limit THEN
    UPDATE gemini_rate_window
    SET call_timestamps = pruned_timestamps || NOW()
    WHERE id = 1;
    RETURN QUERY SELECT true, 0;
  ELSE
    oldest_in_window := pruned_timestamps[1];
    wait_ms := GREATEST(250,
      (EXTRACT(EPOCH FROM (oldest_in_window + INTERVAL '60 seconds' - NOW())) * 1000 + 250)::INT
    );
    RETURN QUERY SELECT false, wait_ms;
  END IF;
END;
$$;
