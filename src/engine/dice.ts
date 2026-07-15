// Dice utilities. RNG is injectable so battles are deterministic in tests and,
// later, authoritative in the Durable Object (never rolled client-side).

export type Rng = () => number;
export const defaultRng: Rng = Math.random;

export function rollD6(rng: Rng = defaultRng): number {
  return 1 + Math.floor(rng() * 6);
}

export interface DiceRoll {
  rolls: number[];
  /** Highest die — the value used for combat/recon resolution. */
  value: number;
}

/** Roll `n` d6 and keep the highest (n = breakthrough or toughness). */
export function rollDice(n: number, rng: Rng = defaultRng): DiceRoll {
  const rolls: number[] = [];
  for (let i = 0; i < Math.max(0, n); i++) rolls.push(rollD6(rng));
  return { rolls, value: rolls.length ? Math.max(...rolls) : 0 };
}

/** Sequential rolls until one player strictly exceeds the other (initiative). */
export function rollUntilDifferent(rng: Rng = defaultRng): { a: number; b: number } {
  let a = rollD6(rng);
  let b = rollD6(rng);
  while (a === b) {
    a = rollD6(rng);
    b = rollD6(rng);
  }
  return { a, b };
}
