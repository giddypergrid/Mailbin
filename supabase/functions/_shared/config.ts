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
  summaryMaxWords: envNumber('MAILBIN_SUMMARY_MAX_WORDS', 10),
  coreMemory: {
    defaultText: envString('MAILBIN_DEFAULT_CORE_MEMORY', [
      'Promotional emails from shopping sites, newsletters, marketing → maybe.',
      'Legal documents, bank statements, tax info, government notices → emergency.',
      'Work emails from colleagues and managers → emergency.',
      'Social media notifications → info.',
      'Meeting invites, calendar reminders → info.',
    ].join('\n')),
    maxLength: envNumber('MAILBIN_CORE_MEMORY_MAX_LENGTH', 5000),
    summaryWordsMin: envNumber('MAILBIN_SUMMARY_WORDS_MIN', 1),
    summaryWordsMax: envNumber('MAILBIN_SUMMARY_WORDS_MAX', 50),
    attachmentKbMin: envNumber('MAILBIN_ATTACHMENT_KB_MIN', 1),
    attachmentKbMax: envNumber('MAILBIN_ATTACHMENT_KB_MAX', 1000),
    attachmentKbDefault: envNumber('MAILBIN_ATTACHMENT_KB_DEFAULT', 100),
  },
  log: {
    level: envString('MAILBIN_LOG_LEVEL', 'info'),
  },
} as const;
