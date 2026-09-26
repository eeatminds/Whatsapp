import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts third-party credentials (Meta access tokens and app secrets) before they are stored,
 * with AES-256-GCM under a key derived from APP_SECRET. A copied database file or backup alone
 * does not reveal them, and each value is bound to the record it belongs to (`context`), so a
 * sealed value moved to another row fails to open.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string, purpose = 'wa-reach/credentials/v1') {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'wa-reach', purpose, 32));
  }

  seal(plain: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  open(sealed: string, context: string): string {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unreadable stored credential');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}
