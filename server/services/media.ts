import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import type { MediaKind, OutboundMedia } from '../openwa/client.js';

export interface Media {
  id: number;
  filename: string;
  mimetype: string;
  size: number;
  kind: MediaKind;
  createdAt: string;
}

interface MediaRow {
  id: number;
  filename: string;
  mimetype: string;
  size: number;
  storage_name: string;
  created_at: string;
}

/** Formats WhatsApp renders natively, with its per-type size limits. */
const ALLOWED: Record<string, { kind: MediaKind; maxBytes: number; ext: string }> = {
  'image/jpeg': { kind: 'image', maxBytes: 5 * 1024 * 1024, ext: '.jpg' },
  'image/png': { kind: 'image', maxBytes: 5 * 1024 * 1024, ext: '.png' },
  'image/webp': { kind: 'image', maxBytes: 5 * 1024 * 1024, ext: '.webp' },
  'video/mp4': { kind: 'video', maxBytes: 16 * 1024 * 1024, ext: '.mp4' },
  'video/3gpp': { kind: 'video', maxBytes: 16 * 1024 * 1024, ext: '.3gp' },
  'audio/mpeg': { kind: 'audio', maxBytes: 16 * 1024 * 1024, ext: '.mp3' },
  'audio/ogg': { kind: 'audio', maxBytes: 16 * 1024 * 1024, ext: '.ogg' },
  'audio/aac': { kind: 'audio', maxBytes: 16 * 1024 * 1024, ext: '.aac' },
  'audio/mp4': { kind: 'audio', maxBytes: 16 * 1024 * 1024, ext: '.m4a' },
  'application/pdf': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.pdf' },
  'application/msword': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.doc' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.docx' },
  'application/vnd.ms-excel': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.xls' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.xlsx' },
  'application/vnd.ms-powerpoint': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.ppt' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.pptx' },
  'text/plain': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.txt' },
  'text/csv': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.csv' },
  'application/zip': { kind: 'document', maxBytes: 30 * 1024 * 1024, ext: '.zip' },
};

export const ACCEPTED_MIME_TYPES = Object.keys(ALLOWED);

export const mediaUploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  mimetype: z.string().trim().toLowerCase(),
  base64: z.string().min(1),
});

export function mediaKind(mimetype: string): MediaKind {
  return ALLOWED[mimetype]?.kind ?? 'document';
}

function toMedia(row: MediaRow): Media {
  return {
    id: row.id,
    filename: row.filename,
    mimetype: row.mimetype,
    size: row.size,
    kind: mediaKind(row.mimetype),
    createdAt: row.created_at,
  };
}

export class MediaService {
  private readonly payloadCache = new Map<number, OutboundMedia>();

  constructor(private readonly core: Core) {}

  list(): Media[] {
    return this.core.db.all<MediaRow>('SELECT * FROM media ORDER BY created_at DESC, id DESC').map(toMedia);
  }

  get(mediaId: number): Media {
    return toMedia(this.row(mediaId));
  }

  exists(mediaId: number): boolean {
    return !!this.core.db.get('SELECT 1 FROM media WHERE id = ?', mediaId);
  }

  private row(mediaId: number): MediaRow {
    const row = this.core.db.get<MediaRow>('SELECT * FROM media WHERE id = ?', mediaId);
    if (!row) throw notFound('Media');
    return row;
  }

  async upload(input: unknown): Promise<Media> {
    const data = mediaUploadSchema.parse(input);
    const spec = ALLOWED[data.mimetype];
    if (!spec) {
      throw badRequest(`Unsupported file type '${data.mimetype}'. WhatsApp accepts JPEG/PNG/WebP images, MP4 video, MP3/OGG/AAC audio and common documents.`);
    }
    const base64 = data.base64.replace(/^data:[^;]+;base64,/, '');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) throw badRequest('The file is empty');
    if (bytes.length > spec.maxBytes) {
      throw badRequest(`${spec.kind} files can be at most ${Math.round(spec.maxBytes / 1024 / 1024)} MB on WhatsApp`);
    }
    const safeName = data.filename.replace(/[\\/\0\r\n]/g, '_');
    const storageName = `${randomToken(20)}${extname(safeName).toLowerCase().replace(/[^.a-z0-9]/g, '') || spec.ext}`;
    await writeFile(join(this.core.config.mediaDir, storageName), bytes);
    const { lastInsertRowid } = this.core.db.run(
      'INSERT INTO media (filename, mimetype, size, storage_name, created_at) VALUES (?, ?, ?, ?, ?)',
      safeName,
      data.mimetype,
      bytes.length,
      storageName,
      nowIso(this.core.clock()),
    );
    return this.get(lastInsertRowid);
  }

  async read(mediaId: number): Promise<{ media: Media; data: Buffer }> {
    const row = this.row(mediaId);
    return { media: toMedia(row), data: await readFile(join(this.core.config.mediaDir, row.storage_name)) };
  }

  /** The payload OpenWA expects, cached so a 1,000-recipient campaign reads the file once. */
  async outbound(mediaId: number): Promise<OutboundMedia> {
    const cached = this.payloadCache.get(mediaId);
    if (cached) return cached;
    const { media, data } = await this.read(mediaId);
    const payload: OutboundMedia = {
      kind: media.kind,
      base64: data.toString('base64'),
      mimetype: media.mimetype,
      filename: media.filename,
    };
    // Bound memory: keep only a handful of recent payloads.
    if (this.payloadCache.size >= 8) this.payloadCache.delete(this.payloadCache.keys().next().value!);
    this.payloadCache.set(mediaId, payload);
    return payload;
  }

  async delete(mediaId: number): Promise<void> {
    const row = this.row(mediaId);
    this.core.db.run('DELETE FROM media WHERE id = ?', mediaId);
    this.payloadCache.delete(mediaId);
    await unlink(join(this.core.config.mediaDir, row.storage_name)).catch(() => undefined);
  }
}
