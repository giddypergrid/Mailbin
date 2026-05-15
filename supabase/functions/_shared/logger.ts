import { requireEnv } from './http.ts';

function shouldLog(): boolean {
  try {
    return requireEnv('MAILBIN_LOG_LEVEL') !== 'silent';
  } catch {
    return true;
  }
} 

export function log(tag: string, message: string, meta?: Record<string, unknown>) {
  if (!shouldLog()) return;
  console.log(`[${tag}] ${message}`, meta ?? '');
}

export function logWeird(tag: string, message: string, meta?: Record<string, unknown>) {
  if (!shouldLog()) return;
  console.warn(`[${tag}][WEIRD] ${message}`, meta ?? '');
}
