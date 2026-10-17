import type { Server } from 'node:http';
import type { Redis } from 'ioredis';
import { createApp, type ServerOptions } from '../api/server.js';
import { Relay, type RelayDependencies } from '../relay/relay.js';
import { Sweeper, type SweeperDependencies } from '../relay/sweeper.js';
import { Worker, type WorkerOptions } from '../worker/worker.js';

export function createApiRuntime(port: number, options: ServerOptions = {}): Server {
  return createApp(options).listen(port);
}

export function createRelayRuntime(dependencies: RelayDependencies = {}, sweeperDependencies: SweeperDependencies = {}): {
  relay: Relay;
  sweeper: Sweeper;
  loop: Promise<void>;
} {
  const relay = new Relay(dependencies);
  const sweeper = new Sweeper(sweeperDependencies);
  const loop = relay.start();
  sweeper.start();
  return { relay, sweeper, loop };
}

export function createWorkerRuntime(options: WorkerOptions = {}): { worker: Worker; loop: Promise<void> } {
  const worker = new Worker(options);
  const loop = worker.start();
  return { worker, loop };
}

export type RuntimeRedis = Redis;
