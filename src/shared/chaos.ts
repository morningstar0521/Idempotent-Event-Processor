export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'SimulatedCrash';
  }
}

type ChaosOptions = { crash?: boolean; pauseAt?: string; failCounter?: number };
let options: ChaosOptions = {};

function enabled(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.CHAOS_ENABLED === 'true';
}

export function configure(next: ChaosOptions): void {
  if (process.env.NODE_ENV === 'test') options = next;
}

export function failBeforeEffect(): void {
  if (enabled() && options.failCounter && options.failCounter > 0) {
    options.failCounter -= 1;
    throw new Error('simulated transient failure');
  }
}

export function crashBeforeCommit(): void {
  if (enabled() && options.crash) throw new SimulatedCrash();
}

export function crashAfterCommit(): void {
  if (enabled() && options.crash) throw new SimulatedCrash();
}

export async function pause(point: 'before_tx' | 'inside_tx'): Promise<void> {
  void point;
  return;
}

export function reset(): void {
  options = {};
}

