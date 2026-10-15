import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export const metricsRegistry = new Registry();
export const eventsReceived = new Counter({ name: 'events_received_total', help: 'Events received', labelNames: ['result'], registers: [metricsRegistry] });
export const duplicatesBlocked = new Counter({ name: 'duplicates_blocked_total', help: 'Duplicates blocked', labelNames: ['layer'], registers: [metricsRegistry] });
export const eventsProcessed = new Counter({ name: 'events_processed_total', help: 'Events processed', registers: [metricsRegistry] });
export const eventsFailed = new Counter({ name: 'events_failed_total', help: 'Events failed', labelNames: ['kind'], registers: [metricsRegistry] });
export const eventsRetried = new Counter({ name: 'events_retried_total', help: 'Events retried', registers: [metricsRegistry] });
export const eventsDead = new Counter({ name: 'events_dead_total', help: 'Events dead', labelNames: ['reason'], registers: [metricsRegistry] });
export const messagesReclaimed = new Counter({ name: 'messages_reclaimed_total', help: 'Messages reclaimed', registers: [metricsRegistry] });
export const sweeperRequeued = new Counter({ name: 'sweeper_requeued_total', help: 'Events requeued by sweeper', registers: [metricsRegistry] });
export const processingDuration = new Histogram({ name: 'processing_duration_seconds', help: 'Processing duration', registers: [metricsRegistry] });
export const apiRequestDuration = new Histogram({ name: 'api_request_duration_seconds', help: 'API request duration', labelNames: ['route', 'status'], registers: [metricsRegistry] });
export const streamLength = new Gauge({ name: 'stream_length', help: 'Stream length', registers: [metricsRegistry] });
export const streamPending = new Gauge({ name: 'stream_pending', help: 'Pending stream messages', registers: [metricsRegistry] });
export const delayedSize = new Gauge({ name: 'delayed_size', help: 'Delayed event count', registers: [metricsRegistry] });

export function metricsContent(): Promise<string> {
  return metricsRegistry.metrics();
}

