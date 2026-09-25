import type { Core } from '../context.js';
import { OpenWAError } from '../openwa/client.js';
import { HttpError } from '../lib/errors.js';
import type { MediaService } from './media.js';

export interface OutgoingContent {
  text: string;
  mediaId?: number | null;
}

export interface SentMessage {
  /** The message whose receipts are tracked (the media message when there is one). */
  messageId: string;
  type: string;
  /** A follow-up text, when the caption did not fit on the media. */
  followUp?: { messageId: string; text: string };
}

const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;

/** Turns app-level content (text + optional library media) into OpenWA send calls. */
export class Sender {
  constructor(
    private readonly core: Core,
    private readonly media: MediaService,
    /** In a multi-business install, refuses numbers that belong to another business. */
    private readonly canUse?: (sessionId: string) => boolean,
  ) {}

  async send(sessionId: string, chatId: string, content: OutgoingContent): Promise<SentMessage> {
    if (this.canUse && !this.canUse(sessionId)) throw new HttpError(403, 'That WhatsApp number does not belong to this account');
    const text = content.text.trim();
    if (text.length > MAX_TEXT) {
      throw new OpenWAError(400, `Message is ${text.length} characters after personalization; WhatsApp allows ${MAX_TEXT}`);
    }
    if (!content.mediaId) {
      if (!text) throw new OpenWAError(400, 'Message has no text and no media');
      const result = await this.core.openwa.sendText(sessionId, chatId, text);
      return { messageId: result.messageId, type: 'text' };
    }

    let payload;
    try {
      payload = await this.media.outbound(content.mediaId);
    } catch {
      throw new OpenWAError(400, 'The media file attached to this message no longer exists');
    }
    const captionFits = payload.kind !== 'audio' && text.length <= MAX_CAPTION;
    const result = await this.core.openwa.sendMedia(sessionId, chatId, payload, captionFits ? text : undefined);
    const sent: SentMessage = { messageId: result.messageId, type: payload.kind };
    if (!captionFits && text) {
      // The media already went out; a failure here must not make the caller retry (and resend) it.
      try {
        const follow = await this.core.openwa.sendText(sessionId, chatId, text);
        sent.followUp = { messageId: follow.messageId, text };
      } catch (error) {
        this.core.log.warn(`Follow-up text after media failed for ${chatId}: ${String(error)}`);
      }
    }
    return sent;
  }
}
