import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Random token from an unambiguous alphabet (no 0/O, 1/l/I), for short links and click tokens. */
export function randomToken(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // Rejection sampling keeps the distribution uniform.
    const limit = 256 - (256 % ALPHABET.length);
    if (bytes[i] < limit) out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out.length === length ? out : randomToken(length);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Verify OpenWA's `X-OpenWA-Signature: sha256=<hex>` over the exact raw request body. */
export function verifyOpenWASignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (typeof header !== 'string' || !secret) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(header, expected);
}

export function signOpenWABody(rawBody: string | Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Stateless signed session token: base64url(json).base64url(hmac). */
export function signSession(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession<T extends { exp: number }>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds?: number; secure?: boolean; path?: string } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
