// One-line-per-call summary timer. summary() always prints exactly one
// structured line (totalMs + caller context) so every invocation logs once
// and only once — call it from a finally so success, early-exit, and error
// paths all funnel through the same line. Per-step deltas are attached only
// when MAILBIN_TIME_TEST=true, keeping normal logs to a single tidy line.
// Uses console.log directly so the heartbeat survives MAILBIN_LOG_LEVEL=silent.

const timingEnabled = Deno.env.get('MAILBIN_TIME_TEST') === 'true';

export interface StepTimer {
  mark(label: string): void;
  summary(context?: Record<string, unknown>): void;
}

export function createTimer(scope: string): StepTimer {
  const startedAt = performance.now();
  let previousAt = startedAt;
  const steps: Array<{ label: string; durationMs: number }> = [];

  return {
    mark(label: string) {
      if (!timingEnabled) return; // marks are free when the probe is off
      const now = performance.now();
      steps.push({ label, durationMs: Math.round(now - previousAt) });
      previousAt = now;
    },
    summary(context: Record<string, unknown> = {}) {
      const payload: Record<string, unknown> = {
        ...context,
        totalMs: Math.round(performance.now() - startedAt),
      };
      if (timingEnabled && steps.length > 0) {
        payload.steps = steps.map((step) => `${step.label}=${step.durationMs}ms`);
      }
      console.log(`[${scope}] ${JSON.stringify(payload)}`);
    },
  };
}
