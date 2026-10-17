import { testQuery } from '../integration/setup.js';

export async function waitForDrain(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await testQuery<{ status: string; count: string }>('SELECT status, count(*)::text AS count FROM events GROUP BY status');
    const histogram = Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
    const unpublished = await testQuery<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL');
    if (!['received', 'retrying'].some((status) => (histogram[status] ?? 0) > 0) && unpublished.rows[0].count === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const result = await testQuery<{ status: string; count: string }>('SELECT status, count(*)::text AS count FROM events GROUP BY status ORDER BY status');
  const unpublished = await testQuery<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL');
  console.error('waitForDrain timeout', { statuses: result.rows, unpublished: unpublished.rows[0].count });
  throw new Error('Timed out waiting for event drain');
}
