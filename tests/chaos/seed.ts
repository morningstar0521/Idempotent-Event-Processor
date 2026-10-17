const seed = Number(process.env.CHAOS_SEED ?? Date.now());
let state = (Number.isFinite(seed) ? seed : Date.now()) >>> 0;

console.log(`CHAOS_SEED=${seed}`);

export function chaosRandom(): number {
  state += 0x6d2b79f5;
  let value = Math.imul(state ^ state >>> 15, 1 | state);
  value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
}

export function resetChaosRandom(): void {
  state = (Number.isFinite(seed) ? seed : Date.now()) >>> 0;
}
