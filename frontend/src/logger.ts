const tag = '[MAILBIN]';

function getLevel(): number {
  const level = import.meta.env.VITE_MAILBIN_LOG_LEVEL ?? 'info';
  const levels: Record<string, number> = { silent: 0, info: 1, weird: 2 };
  return levels[level] ?? 1;
}

export function log(message: string, meta?: unknown) {
  if (getLevel() < 1) return;
  console.log(`${tag} ${message}`, meta ?? '');
}

export function logWeird(message: string, meta?: unknown) {
  if (getLevel() < 2) return;
  console.warn(`${tag}[WEIRD] ${message}`, meta ?? '');
}
