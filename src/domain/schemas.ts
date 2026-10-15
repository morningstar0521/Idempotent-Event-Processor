import { z } from 'zod';

const merchantId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const amountMinor = z.number().int().positive().max(1_000_000_000_000);
const currency = z.literal('INR');

const paymentPayload = z.object({
  merchant_id: merchantId,
  amount_minor: amountMinor,
  currency,
  payment_id: z.string().min(1)
}).strict();

const payoutPayload = z.object({
  merchant_id: merchantId,
  amount_minor: amountMinor,
  currency,
  payout_id: z.string().min(1)
}).strict();

export const paymentEventSchema = z.object({
  type: z.literal('payment.captured'),
  payload: paymentPayload
}).strict();

export const payoutEventSchema = z.object({
  type: z.literal('payout.requested'),
  payload: payoutPayload
}).strict();

export const eventSchema = z.discriminatedUnion('type', [paymentEventSchema, payoutEventSchema]);

export type EventInput = z.infer<typeof eventSchema>;

export function validateIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > 255) {
    throw new Error('Invalid idempotency key');
  }
  return value;
}
