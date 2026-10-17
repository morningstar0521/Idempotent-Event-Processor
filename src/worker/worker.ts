import os from 'node:os';
import type { Redis } from 'ioredis';
import { config } from '../shared/config.js';
import { streamPending } from '../shared/metrics.js';
import { redis } from '../shared/redis.js';
import { moveDue, startDelayedMover } from './delayed.js';
import { handle, releaseHeldLocks, type StreamMessage } from './handler.js';
import { Reaper } from './reaper.js';

const STREAM = 'events:stream';
const GROUP = 'workers';

export interface WorkerOptions {
  redisClient?: Redis;
  concurrency?: number;
  consumerName?: string;
  handleFn?: typeof handle;
}

export class Worker {
  private stopped = false;
  private loopPromise?: Promise<void>;
  private readonly active = new Set<Promise<void>>();
  private readonly redisClient: Redis;
  private readonly concurrency: number;
  private readonly consumerName: string;
  private readonly handleFn: typeof handle;
  private mover?: NodeJS.Timeout;
  private readonly reaper: Reaper;

  constructor(options: WorkerOptions = {}) {
    this.redisClient = options.redisClient ?? redis;
    this.concurrency = options.concurrency ?? config.WORKER_CONCURRENCY;
    this.consumerName = options.consumerName ?? `${os.hostname()}-${process.pid}`;
    this.handleFn = options.handleFn ?? handle;
    this.reaper = new Reaper({ redisClient: this.redisClient, consumerName: this.consumerName, handleFn: this.handleFn });
  }

  async start(): Promise<void> {
    try {
      await this.redisClient.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('BUSYGROUP'))) throw error;
    }
    this.loopPromise = this.run();
    this.mover = startDelayedMover(this.redisClient);
    this.reaper.start();
    await this.loopPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.mover) globalThis.clearInterval(this.mover);
    await this.reaper.stop();
    await this.loopPromise;
    await Promise.all([...this.active]);
    await releaseHeldLocks();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const result = await this.redisClient.xreadgroup(
        'GROUP', GROUP, this.consumerName, 'COUNT', String(this.concurrency), 'BLOCK', '1000', 'STREAMS', STREAM, '>',
      ) as Array<[string, Array<[string, string[]]>]> | null;
      await this.updatePending();
      await moveDue(this.redisClient);
      if (!result) continue;
      const messages = result[0]?.[1] ?? [];
      await Promise.all(messages.map(([id, fields]) => this.dispatch({ id, event_id: fields[fields.indexOf('event_id') + 1] })));
    }
  }

  private dispatch(message: StreamMessage): Promise<void> {
    const task = this.handleFn(message).finally(() => this.active.delete(task));
    this.active.add(task);
    return task;
  }

  private async updatePending(): Promise<void> {
    const summary = await this.redisClient.xpending(STREAM, GROUP);
    if (Array.isArray(summary) && summary[0] !== undefined) streamPending.set(Number(summary[0]));
  }
}
