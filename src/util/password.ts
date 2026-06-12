import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Hash a password using scrypt.
 * Format: <salt>:<hash> (base64)
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64');
  const hash = scryptSync(password, salt, 64).toString('base64');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a hash.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const hashToVerify = scryptSync(password, salt, 64);
  const originalHash = Buffer.from(hash, 'base64');
  return timingSafeEqual(hashToVerify, originalHash);
}
