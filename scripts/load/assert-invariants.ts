import { assertInvariants } from '../../tests/helpers/invariants.js';
import { writeFile } from 'node:fs/promises';

const balances = new Map(Object.entries(JSON.parse(process.argv[2] ?? '{}')) as Array<[string, number]>);
const output = process.argv[4];
try {
  await assertInvariants({ balances, keys: Number(process.argv[3]) });
  if (output) await writeFile(output, JSON.stringify({ status: 'PASS', invariants: Array.from({ length: 10 }, (_, index) => ({ id: `INV-${index + 1}`, status: 'PASS' })) }, null, 2));
  console.log('INV-1..INV-10=PASS');
} catch (error) {
  if (output) await writeFile(output, JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
}
