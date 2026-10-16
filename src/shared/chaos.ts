import { config } from './config.js';

export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'SimulatedCrash';
  }
}

type ChaosOptions = { crash?: boolean; crashAfterRelayXadd?: boolean; pauseAt?: string; failCounter?: number };
let options: ChaosOptions = {};

function enabled(): boolean {
  return process.env.CHAOS_ENABLED === 'true';
}

export function configure(next: ChaosOptions): void {
  if (process.env.NODE_ENV === 'test') options = next;
}

export function failBeforeEffect(): void {
  if (!enabled()) return;
  if (options.failCounter !== undefined) {
    if (options.failCounter <= 0) return;
    options.failCounter -= 1;
  } else if (Math.random() >= config.CHAOS_FAIL_PROB) return;
  throw new TransientError('simulated transient failure');
}

export function crashBeforeCommit(): void {
  crash(options.crash ?? Math.random() < config.CHAOS_CRASH_BEFORE_COMMIT_PROB);
}

export function crashAfterCommit(): void {
  crash(options.crash ?? Math.random() < config.CHAOS_CRASH_AFTER_COMMIT_PROB);
}

export function crashAfterRelayXadd(): void {
  if (enabled() && options.crashAfterRelayXadd) throw new SimulatedCrash();
}

export async function pause(point: 'before_tx' | 'inside_tx'): Promise<void> {
  if (!enabled() || (options.pauseAt && options.pauseAt !== point) || (!options.pauseAt && process.env.NODE_ENV !== 'test' && point !== 'before_tx')) return;
  const delay = config.CHAOS_PAUSE_MS;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

export function reset(): void {
  options = {};
}

function crash(shouldCrash = false): void {
  if (!enabled() || !shouldCrash) return;
  if (process.env.NODE_ENV === 'test') throw new SimulatedCrash();
  process.kill(process.pid, 'SIGKILL');
}

class TransientError extends Error {
  readonly kind = 'transient' as const;
}

