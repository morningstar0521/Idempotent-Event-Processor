import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiRuntime, createRelayRuntime, createWorkerRuntime } from '../../src/bin/factories.js';
import { handle } from '../../src/worker/handler.js';
import { pause } from '../../src/shared/chaos.js';
import { startHeartbeat, type Heartbeat } from '../../src/worker/lock.js';
import { Reaper } from '../../src/worker/reaper.js';
import { testPool, testQuery, testRedis, testWithTx } from '../integration/setup.js';

export interface StackOptions {
  workers?: number;
  concurrency?: number;
  pauseWorkerId?: number;
  disableHeartbeatWorkerId?: number;
}

export interface Stack {
  api: { server: Server; url: string };
  relay: ReturnType<typeof createRelayRuntime>;
  workers: Array<ReturnType<typeof createWorkerRuntime>['worker']>;
  stop(): Promise<void>;
  kill(workerId: number): Promise<void>;
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const server = createApiRuntime(0, { queryFn: testQuery, withTxFn: testWithTx, redisClient: testRedis });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const relay = createRelayRuntime(
    { redisClient: testRedis, withTxFn: testWithTx },
    { redisClient: testRedis, poolClient: testPool },
  );
  const workers: Array<ReturnType<typeof createWorkerRuntime>['worker']> = [];
  const generations = new Map<number, number>();
  let stopping = false;
  const startWorker = (index: number): void => {
    const generation = (generations.get(index) ?? 0) + 1;
    generations.set(index, generation);
    const runtime = createWorkerRuntime({
      redisClient: testRedis,
      concurrency: options.concurrency,
      consumerName: `chaos-${process.pid}-${index}-${generation}`,
      handleFn: (message) => handle(message, {
        redisClient: testRedis,
        withTxFn: testWithTx,
        pauseFn: options.pauseWorkerId === index ? pause : async () => undefined,
        startHeartbeatFn: options.disableHeartbeatWorkerId === index
          ? (() => ({ stop: () => undefined, lostLock: false }) as Heartbeat)
          : startHeartbeat,
      }),
      queryFn: testQuery,
    });
    workers[index] = runtime.worker;
    void runtime.loop.catch(() => {
      if (!stopping) startWorker(index);
    });
  };
  for (let index = 0; index < (options.workers ?? 1); index += 1) startWorker(index);
  const supervisor = new Reaper({
    redisClient: testRedis,
    consumerName: `chaos-supervisor-${process.pid}`,
    handleFn: (message) => handle(message, { redisClient: testRedis, withTxFn: testWithTx }),
    queryFn: testQuery,
  });
  supervisor.start();
  return {
    api: { server, url: `http://127.0.0.1:${address.port}` },
    relay,
    workers,
    async stop() {
      stopping = true;
      await Promise.all(workers.map((worker) => worker.stop()));
      await supervisor.stop();
      await relay.relay.stop();
      await relay.sweeper.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    async kill(workerId) {
      const worker = workers[workerId];
      if (!worker) throw new Error(`Unknown worker ${workerId}`);
      await worker.kill();
    },
  };
}
