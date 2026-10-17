import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

type Result = { id: string; status: 'PASS' | 'FAIL'; detail: string };
const results: Result[] = [];

function command(args: string[]): string {
  return execFileSync('docker', ['compose', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function scenario(id: string, action: () => void): void {
  try {
    action();
    results.push({ id, status: 'PASS', detail: 'Docker action completed' });
  } catch (error) {
    results.push({ id, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
  }
}

try {
  command(['up', '-d', '--build', '--scale', 'worker=3']);
  scenario('CF-1', () => {
    const worker = command(['ps', '-q', 'worker']).split('\n').filter(Boolean)[0];
    if (!worker) throw new Error('No worker container found');
    execFileSync('docker', ['kill', '-s', 'KILL', worker], { stdio: 'pipe' });
  });
  scenario('CF-2', () => { command(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']); });
  scenario('CF-3', () => { command(['restart', 'redis']); });
  scenario('CF-4', () => { command(['restart', 'postgres']); });
  scenario('CF-5', () => {
    const worker = command(['ps', '-q', 'worker']).split('\n').filter(Boolean)[0];
    if (!worker) throw new Error('No worker container found');
    execFileSync('docker', ['stop', worker], { stdio: 'pipe' });
  });
  scenario('CF-6', () => {
    const worker = command(['ps', '-q', 'worker']).split('\n').filter(Boolean)[0];
    if (!worker) throw new Error('No worker container found');
    execFileSync('docker', ['kill', '-s', 'KILL', worker], { stdio: 'pipe' });
    command(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']);
  });
} finally {
  try { command(['down']); } catch { /* preserve the scenario result */ }
}

await mkdir('scripts/chaos', { recursive: true });
await writeFile('scripts/chaos/results.json', JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2) + '\n');
console.table(results);
if (results.some((result) => result.status === 'FAIL')) process.exitCode = 1;
