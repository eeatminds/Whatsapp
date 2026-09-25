import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { conflict, notFound } from '../lib/errors.js';

export interface Tag {
  id: number;
  name: string;
  color: string;
  count?: number;
}

const PALETTE = ['#128C7E', '#2563EB', '#9333EA', '#DB2777', '#EA580C', '#CA8A04', '#16A34A', '#0891B2', '#64748B'];

export const tagInputSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

export class TagsService {
  constructor(private readonly core: Core) {}

  list(): Tag[] {
    return this.core.db.all<Tag>(
      `SELECT t.id, t.name, t.color, COUNT(ct.contact_id) AS count
         FROM tags t LEFT JOIN contact_tags ct ON ct.tag_id = t.id
        GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
    );
  }

  get(tagId: number): Tag {
    const tag = this.core.db.get<Tag>('SELECT id, name, color FROM tags WHERE id = ?', tagId);
    if (!tag) throw notFound('Tag');
    return tag;
  }

  exists(tagId: number): boolean {
    return !!this.core.db.get('SELECT 1 FROM tags WHERE id = ?', tagId);
  }

  create(input: unknown): Tag {
    const data = tagInputSchema.parse(input);
    if (this.core.db.get('SELECT 1 FROM tags WHERE name = ?', data.name)) {
      throw conflict(`A tag named '${data.name}' already exists`);
    }
    const { lastInsertRowid } = this.core.db.run(
      'INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)',
      data.name,
      data.color ?? this.nextColor(),
      nowIso(this.core.clock()),
    );
    return this.get(lastInsertRowid);
  }

  update(tagId: number, input: unknown): Tag {
    this.get(tagId);
    const data = tagInputSchema.parse(input);
    const clash = this.core.db.get<{ id: number }>('SELECT id FROM tags WHERE name = ?', data.name);
    if (clash && clash.id !== tagId) throw conflict(`A tag named '${data.name}' already exists`);
    this.core.db.run('UPDATE tags SET name = ?, color = COALESCE(?, color) WHERE id = ?', data.name, data.color ?? null, tagId);
    return this.get(tagId);
  }

  delete(tagId: number): void {
    const { changes } = this.core.db.run('DELETE FROM tags WHERE id = ?', tagId);
    if (!changes) throw notFound('Tag');
  }

  /** Find a tag by name (case-insensitive) or create it. Used by imports and automations. */
  ensure(name: string): number {
    const trimmed = name.trim().slice(0, 50);
    const existing = this.core.db.get<{ id: number }>('SELECT id FROM tags WHERE name = ?', trimmed);
    if (existing) return existing.id;
    return this.core.db.run(
      'INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)',
      trimmed,
      this.nextColor(),
      nowIso(this.core.clock()),
    ).lastInsertRowid;
  }

  private nextColor(): string {
    const n = this.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tags')?.n ?? 0;
    return PALETTE[n % PALETTE.length];
  }
}
