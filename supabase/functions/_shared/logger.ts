import { CONFIG } from './config.ts';

function shouldLog(): boolean {
  return CONFIG.log.level !== 'silent';
} 

export function log(tag: string, message: string, meta?: Record<string, unknown>) {
  if (!shouldLog()) return;
  console.log(`[${tag}] ${message}`, meta ?? '');
}

export function logWeird(tag: string, message: string, meta?: Record<string, unknown>) {
  if (!shouldLog()) return;
  console.warn(`[${tag}][WEIRD] ${message}`, meta ?? '');
}
