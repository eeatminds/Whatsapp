import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const COST = 16384;

/** scrypt password hash: "scrypt$<N>$<salt b64>$<hash b64>". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: COST });
  return `scrypt$${COST}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, cost, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(cost) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const WORDS = [
  'amber', 'anchor', 'apple', 'arrow', 'aspen', 'basil', 'birch', 'bloom', 'breeze', 'brook', 'cactus', 'cedar',
  'cherry', 'cloud', 'cobalt', 'comet', 'coral', 'crane', 'delta', 'ember', 'falcon', 'fern', 'flint', 'forest',
  'garnet', 'ginger', 'glacier', 'harbor', 'hazel', 'indigo', 'iris', 'jade', 'jasmine', 'kite', 'lagoon', 'lemon',
  'lotus', 'lunar', 'mango', 'maple', 'meadow', 'mint', 'monsoon', 'nectar', 'nova', 'oasis', 'olive', 'onyx',
  'orbit', 'orchid', 'pearl', 'pepper', 'pine', 'plum', 'prism', 'quartz', 'raven', 'river', 'saffron', 'sage',
  'sierra', 'solar', 'spruce', 'tiger',
];

/** A readable temporary password for new accounts, e.g. "kite-7294-mango-river" (about 2^34 combinations). */
export function temporaryPassword(): string {
  const pick = () => WORDS[randomBytes(1)[0] % WORDS.length];
  const digits = String(1000 + (randomBytes(2).readUInt16BE(0) % 9000));
  return `${pick()}-${digits}-${pick()}-${pick()}`;
}
