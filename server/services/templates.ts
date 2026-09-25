import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { contactVariables, renderTemplate, templateVariables } from '../lib/template.js';
import type { MediaService } from './media.js';
import type { ContactsService } from './contacts.js';
import type { SettingsService } from './settings.js';

export interface Template {
  id: number;
  name: string;
  body: string;
  mediaId: number | null;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: number;
  name: string;
  body: string;
  media_id: number | null;
  created_at: string;
  updated_at: string;
}

export const MAX_BODY = 4096;

export const templateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    body: z.string().max(MAX_BODY).default(''),
    mediaId: z.coerce.number().int().positive().nullish(),
  })
  .refine(t => t.body.trim() !== '' || !!t.mediaId, 'A template needs text, media, or both');

function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    mediaId: row.media_id,
    variables: templateVariables(row.body),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Sample data for previews when no real contact is chosen. */
const SAMPLE = { name: 'Priya Sharma', phone: '919876543210', email: 'priya@example.com', attributes: { city: 'Bengaluru' } };

export class TemplatesService {
  constructor(
    private readonly core: Core,
    private readonly media: MediaService,
    private readonly contacts: ContactsService,
    private readonly settings: SettingsService,
  ) {}

  list(): Template[] {
    return this.core.db.all<TemplateRow>('SELECT * FROM templates ORDER BY updated_at DESC').map(toTemplate);
  }

  get(templateId: number): Template {
    const row = this.core.db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', templateId);
    if (!row) throw notFound('Template');
    return toTemplate(row);
  }

  private validate(input: unknown) {
    const data = templateInputSchema.parse(input);
    if (data.mediaId && !this.media.exists(data.mediaId)) throw badRequest('The selected media file no longer exists');
    return data;
  }

  create(input: unknown): Template {
    const data = this.validate(input);
    const now = nowIso(this.core.clock());
    const { lastInsertRowid } = this.core.db.run(
      'INSERT INTO templates (name, body, media_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      data.name,
      data.body,
      data.mediaId ?? null,
      now,
      now,
    );
    return this.get(lastInsertRowid);
  }

  update(templateId: number, input: unknown): Template {
    this.get(templateId);
    const data = this.validate(input);
    this.core.db.run(
      'UPDATE templates SET name = ?, body = ?, media_id = ?, updated_at = ? WHERE id = ?',
      data.name,
      data.body,
      data.mediaId ?? null,
      nowIso(this.core.clock()),
      templateId,
    );
    return this.get(templateId);
  }

  delete(templateId: number): void {
    const { changes } = this.core.db.run('DELETE FROM templates WHERE id = ?', templateId);
    if (!changes) throw notFound('Template');
  }

  /** Render text for a contact (or sample data), exactly as the dispatcher will. */
  preview(body: string, contactId?: number): { text: string; missing: string[] } {
    const businessName = this.settings.get().businessName;
    if (contactId) {
      const contact = this.contacts.get(contactId);
      return renderTemplate(body, contactVariables(contact, { business_name: businessName }));
    }
    return renderTemplate(body, contactVariables(SAMPLE, { business_name: businessName }));
  }
}
