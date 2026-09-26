import { MetaError, metaErrorText, type MetaApi, type MetaPhoneNumber, type MetaTemplate } from '../server/meta/client.js';

/** In-memory stand-in for Meta's Graph API, with one valid token per phone number. */
export class FakeMeta implements MetaApi {
  readonly numbers = new Map<string, MetaPhoneNumber & { token: string; wabaId: string }>();
  readonly templatesByWaba = new Map<string, MetaTemplate[]>();
  readonly sent: Array<{ phoneNumberId: string; message: Record<string, any> }> = [];
  readonly uploads: Array<{ phoneNumberId: string; filename: string; mimetype: string }> = [];
  /** Next send fails with this Meta error code. */
  failNext: { code: number; status?: number } | null = null;
  private counter = 0;

  addNumber(input: { id: string; wabaId: string; token: string; display?: string; name?: string }): void {
    this.numbers.set(input.id, {
      id: input.id,
      wabaId: input.wabaId,
      token: input.token,
      display_phone_number: input.display ?? '+91 99000 11111',
      verified_name: input.name ?? 'Test Shop',
      quality_rating: 'GREEN',
    });
  }

  private auth(token: string, phoneNumberId: string) {
    const number = this.numbers.get(phoneNumberId);
    if (!number) throw new MetaError(400, 'Unsupported get request (Meta error 100)', 100);
    if (number.token !== token) throw new MetaError(401, 'The access token is invalid or has expired (Meta error 190)', 190);
    return number;
  }

  async phoneNumber(token: string, phoneNumberId: string): Promise<MetaPhoneNumber> {
    const { token: _t, wabaId: _w, ...info } = this.auth(token, phoneNumberId);
    return info;
  }

  async subscribeApp(token: string, wabaId: string): Promise<void> {
    if (![...this.numbers.values()].some(n => n.wabaId === wabaId && n.token === token)) {
      throw new MetaError(400, 'Unsupported post request (Meta error 100)', 100);
    }
  }

  async templates(token: string, wabaId: string): Promise<MetaTemplate[]> {
    await this.subscribeApp(token, wabaId);
    return this.templatesByWaba.get(wabaId) ?? [];
  }

  async send(token: string, phoneNumberId: string, message: Record<string, unknown>): Promise<{ messageId: string }> {
    this.auth(token, phoneNumberId);
    if (this.failNext) {
      const { code, status } = this.failNext;
      this.failNext = null;
      throw new MetaError(status ?? 400, `${metaErrorText(code, 'Meta error')} (Meta error ${code})`, code);
    }
    this.sent.push({ phoneNumberId, message });
    return { messageId: `wamid.${++this.counter}` };
  }

  async uploadMedia(token: string, phoneNumberId: string, file: { data: Buffer; mimetype: string; filename: string }): Promise<string> {
    this.auth(token, phoneNumberId);
    this.uploads.push({ phoneNumberId, filename: file.filename, mimetype: file.mimetype });
    return `media.${++this.counter}`;
  }
}
