function envNumber(key: string, fallback: number): number {
  const value = Deno.env.get(key);
  const parsed = Number(value);
  return value && !Number.isNaN(parsed) ? parsed : fallback;
}

const envString = (key: string, fallback: string): string =>
  Deno.env.get(key) ?? fallback;

export const CONFIG = {
  fetch: {
    limit: envNumber('MAILBIN_FETCH_LIMIT', 10),
    batchSize: envNumber('MAILBIN_FETCH_BATCH_SIZE', 3),
    batchDelayMs: envNumber('MAILBIN_FETCH_BATCH_DELAY_MS', 300),
    tokenRefreshWindowMs: envNumber('MAILBIN_FETCH_TOKEN_REFRESH_WINDOW_MS', 60000),
  },
  gemini: {
    apiKey: Deno.env.get('GEMINI_API_KEY') ?? '',
    model: envString('MAILBIN_GEMINI_MODEL', 'gemini-2.5-flash-lite'),
  },
  coreMemory: {
    maxRules: 5,
    maxRuleLength: 20,
    defaultRules: [
      'Promotional emails from shopping sites, newsletters, marketing → maybe.',
      'Legal documents, bank statements, tax info, government notices → emergency.',
      'Work emails from colleagues and managers → emergency.',
      'Social media notifications → info.',
      'Meeting invites, calendar reminders → info.',
    ],
    maxLength: envNumber('MAILBIN_CORE_MEMORY_MAX_LENGTH', 5000),
    attachmentKbMin: envNumber('MAILBIN_ATTACHMENT_KB_MIN', 1),
    attachmentKbMax: envNumber('MAILBIN_ATTACHMENT_KB_MAX', 1000),
    attachmentKbDefault: envNumber('MAILBIN_ATTACHMENT_KB_DEFAULT', 100),
  },
  sync: {
    baselineMax: envNumber('MAILBIN_SYNC_BASELINE_MAX', 50),
    incrementalMax: envNumber('MAILBIN_SYNC_INCREMENTAL_MAX', 200),
    pollIntervalMs: envNumber('MAILBIN_SYNC_POLL_INTERVAL_MS', 2000),
    retryDelayMs: envNumber('MAILBIN_SYNC_RETRY_DELAY_MS', 5000),
    maxRetries: envNumber('MAILBIN_SYNC_MAX_RETRIES', 3),
  },
  log: {
    level: envString('MAILBIN_LOG_LEVEL', 'info'),
  },
} as const;
