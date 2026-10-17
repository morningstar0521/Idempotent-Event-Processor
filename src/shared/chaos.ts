import { config } from './config.js';
import { chaosFires } from './metrics.js';

export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'SimulatedCrash';
  }
}

export type ChaosProbability = { prob: number; firesOnce?: boolean };
export type ChaosOptions = {
  crash?: boolean;
  crashAfterRelayXadd?: boolean;
  pauseAt?: string;
  failCounter?: number;
  crashBeforeCommit?: ChaosProbability;
  crashAfterCommit?: ChaosProbability;
  pauseBeforeTx?: { durationMs: number };
  pauseInsideTx?: { durationMs: number };
  pauseEventId?: string;
  poisonEventId?: string;
  failAlwaysEventId?: string;
  crashRelayAfterXadd?: ChaosProbability;
  failBeforeEffect?: ChaosProbability;
};
let options: ChaosOptions = {};
const firedOnce = new Set<string>();
const firedEvents = new Set<string>();

function enabled(): boolean {
  return process.env.CHAOS_ENABLED === 'true';
}

export function configure(next: ChaosOptions): void {
  if (process.env.NODE_ENV === 'test') options = next;
}

export function failBeforeEffect(eventId?: string): void {
  if (!enabled()) return;
  void eventId;
  if (options.failAlwaysEventId === eventId) {
    chaosFires.inc({ cause: 'fail_before_effect' });
    throw new TransientError('simulated transient failure');
  }
  if (options.failBeforeEffect) {
    if (!shouldFire('fail_before_effect', options.failBeforeEffect)) return;
    throw new TransientError('simulated transient failure');
  }
  if (options.failCounter !== undefined) {
    if (options.failCounter <= 0) return;
    options.failCounter -= 1;
  } else if (Math.random() >= config.CHAOS_FAIL_PROB) return;
  throw new TransientError('simulated transient failure');
}

export function crashBeforeCommit(eventId?: string): void {
  const shouldCrash = options.crashBeforeCommit
    ? shouldFire('crash_before_commit', options.crashBeforeCommit, eventId)
    : options.crash ?? Math.random() < config.CHAOS_CRASH_BEFORE_COMMIT_PROB;
  crash(shouldCrash, 'crash_before_commit');
}

export function crashAfterCommit(eventId?: string): void {
  const shouldCrash = options.crashAfterCommit
    ? shouldFire('crash_after_commit', options.crashAfterCommit, eventId)
    : options.crash ?? Math.random() < config.CHAOS_CRASH_AFTER_COMMIT_PROB;
  crash(shouldCrash, 'crash_after_commit');
}

export function crashAfterRelayXadd(): void {
  if (!enabled()) return;
  if (options.crashRelayAfterXadd && shouldFire('crash_relay_after_xadd', options.crashRelayAfterXadd)) {
    throw new SimulatedCrash();
  }
  if (options.crashAfterRelayXadd) {
    chaosFires.inc({ cause: 'crash_relay_after_xadd' });
    throw new SimulatedCrash();
  }
}

export async function pause(point: 'before_tx' | 'inside_tx', eventId?: string): Promise<void> {
  if (!enabled() || (options.pauseAt && options.pauseAt !== point) || (!options.pauseAt && process.env.NODE_ENV !== 'test' && point !== 'before_tx')) return;
  if (options.pauseEventId && options.pauseEventId !== eventId) return;
  const delay = point === 'before_tx' ? options.pauseBeforeTx?.durationMs : options.pauseInsideTx?.durationMs;
  const configuredDelay = delay ?? config.CHAOS_PAUSE_MS;
  if (configuredDelay > 0) {
    chaosFires.inc({ cause: point === 'before_tx' ? 'pause_before_tx' : 'pause_inside_tx' });
    await new Promise((resolve) => setTimeout(resolve, configuredDelay));
  }
}

export function poison(eventId: string): void {
  if (enabled() && options.poisonEventId === eventId) {
    chaosFires.inc({ cause: 'poison_message' });
    throw new SimulatedCrash();
  }
}

export function reset(): void {
  options = {};
  firedOnce.clear();
  firedEvents.clear();
}

function shouldFire(cause: string, hook: ChaosProbability, eventId?: string): boolean {
  if (hook.firesOnce && firedOnce.has(cause)) return false;
  const eventKey = eventId ? `${cause}:${eventId}` : undefined;
  if (eventKey && firedEvents.has(eventKey)) return false;
  if (Math.random() >= hook.prob) return false;
  if (hook.firesOnce) firedOnce.add(cause);
  if (eventKey) firedEvents.add(eventKey);
  chaosFires.inc({ cause });
  return true;
}

function crash(shouldCrash = false, cause: string): void {
  if (!enabled() || !shouldCrash) return;
  if (!options.crashBeforeCommit && !options.crashAfterCommit) chaosFires.inc({ cause });
  if (process.env.NODE_ENV === 'test') throw new SimulatedCrash();
  process.kill(process.pid, 'SIGKILL');
}

class TransientError extends Error {
  readonly kind = 'transient' as const;
}

