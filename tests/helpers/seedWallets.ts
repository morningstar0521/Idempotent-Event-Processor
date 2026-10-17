import { postEvent } from './postEvent.js';
import { waitForDrain } from './waitForDrain.js';

export async function seedWallets(merchants: string[], amount: number, baseUrl: string): Promise<Map<string, number>> {
  const model = new Map(merchants.map((merchant) => [merchant, amount]));
  await Promise.all(merchants.map((merchant, index) => postEvent(`seed-${index}-${merchant}`, {
    type: 'payment.captured',
    payload: { merchant_id: merchant, amount_minor: amount, currency: 'INR', payment_id: `seed-${index}` },
  }, baseUrl)));
  await waitForDrain();
  return model;
}
