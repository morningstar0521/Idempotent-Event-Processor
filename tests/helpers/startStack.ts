import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiRuntime, createRelayRuntime, createWorkerRuntime } from '../../src/bin/factories.js';
import { handle } from '../../src/worker/handler.js';
import { testPool, testQuery, testRedis, testWithTx } from '../integration/setup.js';

export interface StackOptions {
  workers?: number;
  concurrency?: number;
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
  const workers = Array.from({ length: options.workers ?? 1 }, (_, index) => {
    const runtime = createWorkerRuntime({
      redisClient: testRedis,
      concurrency: options.concurrency,
      consumerName: `chaos-${process.pid}-${index}`,
      handleFn: (message) => handle(message, { redisClient: testRedis, withTxFn: testWithTx }),
      queryFn: testQuery,
    });
    void runtime.loop.catch(() => undefined);
    return runtime.worker;
  });
  return {
    api: { server, url: `http://127.0.0.1:${address.port}` },
    relay,
    workers,
    async stop() {
      await Promise.all(workers.map((worker) => worker.stop()));
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
