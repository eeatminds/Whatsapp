import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso, parseJson } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { contactVariables, renderTemplate } from '../lib/template.js';
import type { SettingsService } from './settings.js';
import type { MediaService } from './media.js';
import type { TagsService } from './tags.js';
import type { Bus } from './bus.js';
import type { ContactRow } from './contacts.js';
import { toContact } from './contacts.js';

const id = z.coerce.number().int().positive();

export const stepSchema = z
  .object({
    /** Wait after the previous step (or after enrollment, for the first step). */
    delayMinutes: z.coerce.number().int().min(0).max(60 * 24 * 365),
    body: z.string().max(4000).default(''),
    mediaId: id.nullish(),
  })
  .refine(s => s.body.trim() !== '' || !!s.mediaId, 'Each step needs text, media, or both');

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('tag_added'), tagId: id }),
  z.object({ type: z.literal('opted_in') }),
]);

export const sequenceOptionsSchema = z.object({
  stopOnReply: z.boolean().default(true),
  respectQuietHours: z.boolean().default(true),
  requireOptIn: z.boolean().default(false),
  appendOptOut: z.boolean().default(true),
});

export const sequenceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
  sessionId: z.string().trim().min(1).nullish(),
  trigger: triggerSchema.default({ type: 'manual' }),
  steps: z.array(stepSchema).min(1).max(30),
  options: sequenceOptionsSchema.default({ stopOnReply: true, respectQuietHours: true, requireOptIn: false, appendOptOut: true }),
});

export type Step = z.infer<typeof stepSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type SequenceOptions = z.infer<typeof sequenceOptionsSchema>;

export interface Sequence {
  id: number;
  name: string;
  active: boolean;
  sessionId: string | null;
  trigger: Trigger;
  steps: Step[];
  options: SequenceOptions;
  createdAt: string;
  updatedAt: string;
  counts: { active: number; completed: number; stopped: number };
}

interface SequenceRow {
  id: number;
  name: string;
  active: number;
  session_id: string | null;
  trigger: string;
  steps: string;
  options: string;
  created_at: string;
  updated_at: string;
}

export interface EnrollmentRow {
  id: number;
  sequence_id: number;
  contact_id: number;
  status: 'active' | 'sending' | 'completed' | 'stopped';
  current_step: number;
  next_run_at: string | null;
  stop_reason: string | null;
  enrolled_at: string;
  updated_at: string;
}

export class SequencesService {
  constructor(
    private readonly core: Core,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
    private readonly tags: TagsService,
    bus: Bus,
  ) {
    bus.on('tag.added', ({ contactId, tagId }) => this.onTagAdded(contactId, tagId));
    bus.on('consent.changed', ({ contactId, to }) => this.onConsentChanged(contactId, to));
    bus.on('contact.replied', ({ contactId }) => this.onReplied(contactId));
  }

  private now(): string {
    return nowIso(this.core.clock());
  }

  private toSequence(row: SequenceRow): Sequence {
    const counts = this.core.db.get<{ active: number; completed: number; stopped: number }>(
      `SELECT SUM(status IN ('active', 'sending')) AS active, SUM(status = 'completed') AS completed, SUM(status = 'stopped') AS stopped
         FROM sequence_enrollments WHERE sequence_id = ?`,
      row.id,
    );
    return {
      id: row.id,
      name: row.name,
      active: !!row.active,
      sessionId: row.session_id,
      trigger: parseJson<Trigger>(row.trigger, { type: 'manual' }),
      steps: parseJson<Step[]>(row.steps, []),
      options: sequenceOptionsSchema.parse(parseJson(row.options, {})),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      counts: { active: counts?.active ?? 0, completed: counts?.completed ?? 0, stopped: counts?.stopped ?? 0 },
    };
  }

  private row(sequenceId: number): SequenceRow {
    const row = this.core.db.get<SequenceRow>('SELECT * FROM sequences WHERE id = ?', sequenceId);
    if (!row) throw notFound('Sequence');
    return row;
  }

  list(): Sequence[] {
    return this.core.db.all<SequenceRow>('SELECT * FROM sequences ORDER BY created_at DESC').map(r => this.toSequence(r));
  }

  get(sequenceId: number): Sequence {
    return this.toSequence(this.row(sequenceId));
  }

  private validate(input: unknown) {
    const data = sequenceInputSchema.parse(input);
    if (data.trigger.type === 'tag_added' && !this.tags.exists(data.trigger.tagId)) throw badRequest('The trigger tag no longer exists');
    for (const step of data.steps) {
      if (step.mediaId && !this.media.exists(step.mediaId)) throw badRequest('A step references a media file that no longer exists');
    }
    return data;
  }

  create(input: unknown): Sequence {
    const data = this.validate(input);
    const now = this.now();
    const { lastInsertRowid } = this.core.db.run(
      `INSERT INTO sequences (name, active, session_id, trigger, steps, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      data.name,
      data.active,
      data.sessionId ?? null,
      JSON.stringify(data.trigger),
      JSON.stringify(data.steps),
      JSON.stringify(data.options),
      now,
      now,
    );
    return this.get(lastInsertRowid);
  }

  update(sequenceId: number, input: unknown): Sequence {
    this.row(sequenceId);
    const data = this.validate(input);
    this.core.db.tx(() => {
      this.core.db.run(
        `UPDATE sequences SET name = ?, active = ?, session_id = ?, trigger = ?, steps = ?, options = ?, updated_at = ? WHERE id = ?`,
        data.name,
        data.active,
        data.sessionId ?? null,
        JSON.stringify(data.trigger),
        JSON.stringify(data.steps),
        JSON.stringify(data.options),
        this.now(),
        sequenceId,
      );
      // Enrollments past the (possibly shortened) last step are finished.
      this.core.db.run(
        "UPDATE sequence_enrollments SET status = 'completed', next_run_at = NULL, updated_at = ? WHERE sequence_id = ? AND status = 'active' AND current_step >= ?",
        this.now(),
        sequenceId,
        data.steps.length,
      );
    });
    return this.get(sequenceId);
  }

  delete(sequenceId: number): void {
    const { changes } = this.core.db.run('DELETE FROM sequences WHERE id = ?', sequenceId);
    if (!changes) throw notFound('Sequence');
  }

  // ---------------------------------------------------------------- enrollment

  /**
   * Enroll contacts. Opted-out contacts are never enrolled. An existing active enrollment is left
   * alone; a finished one is restarted only when `restart` is set (manual re-enrollment).
   */
  enroll(sequenceId: number, contactIds: number[], restart = false): { enrolled: number; skipped: number } {
    const sequence = this.get(sequenceId);
    if (sequence.steps.length === 0) throw badRequest('The sequence has no steps');
    const firstRun = nowIso(new Date(this.core.clock().getTime() + sequence.steps[0].delayMinutes * 60_000));
    let enrolled = 0;
    let skipped = 0;
    this.core.db.tx(() => {
      for (const contactId of contactIds) {
        const contact = this.core.db.get<{ consent: string }>('SELECT consent FROM contacts WHERE id = ?', contactId);
        if (!contact || contact.consent === 'opted_out' || (sequence.options.requireOptIn && contact.consent !== 'opted_in')) {
          skipped++;
          continue;
        }
        const existing = this.core.db.get<EnrollmentRow>(
          'SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND contact_id = ?',
          sequenceId,
          contactId,
        );
        if (existing) {
          if (existing.status === 'active' || existing.status === 'sending' || !restart) {
            skipped++;
            continue;
          }
          this.core.db.run(
            `UPDATE sequence_enrollments SET status = 'active', current_step = 0, next_run_at = ?, stop_reason = NULL,
                    enrolled_at = ?, updated_at = ? WHERE id = ?`,
            firstRun,
            this.now(),
            this.now(),
            existing.id,
          );
        } else {
          this.core.db.run(
            `INSERT INTO sequence_enrollments (sequence_id, contact_id, status, current_step, next_run_at, enrolled_at, updated_at)
             VALUES (?, ?, 'active', 0, ?, ?, ?)`,
            sequenceId,
            contactId,
            firstRun,
            this.now(),
            this.now(),
          );
        }
        enrolled++;
      }
    });
    return { enrolled, skipped };
  }

  stopEnrollment(enrollmentId: number, reason: string): void {
    this.core.db.run(
      "UPDATE sequence_enrollments SET status = 'stopped', stop_reason = ?, next_run_at = NULL, updated_at = ? WHERE id = ? AND status IN ('active', 'sending')",
      reason,
      this.now(),
      enrollmentId,
    );
  }

  enrollments(sequenceId: number, page = 1, pageSize = 50) {
    this.row(sequenceId);
    const size = Math.min(Math.max(pageSize, 1), 500);
    const total = this.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id = ?', sequenceId)?.n ?? 0;
    const items = this.core.db.all<EnrollmentRow & { name: string | null; phone: string }>(
      `SELECT e.*, c.name, c.phone FROM sequence_enrollments e JOIN contacts c ON c.id = e.contact_id
        WHERE e.sequence_id = ? ORDER BY e.enrolled_at DESC, e.id DESC LIMIT ? OFFSET ?`,
      sequenceId,
      size,
      (Math.max(page, 1) - 1) * size,
    );
    return {
      total,
      items: items.map(e => ({
        id: e.id,
        contactId: e.contact_id,
        name: e.name,
        phone: e.phone,
        status: e.status,
        currentStep: e.current_step,
        nextRunAt: e.next_run_at,
        stopReason: e.stop_reason,
        enrolledAt: e.enrolled_at,
      })),
    };
  }

  contactEnrollments(contactId: number) {
    return this.core.db.all<{ id: number; sequence_id: number; name: string; status: string; current_step: number; next_run_at: string | null }>(
      `SELECT e.id, e.sequence_id, s.name, e.status, e.current_step, e.next_run_at FROM sequence_enrollments e
         JOIN sequences s ON s.id = e.sequence_id WHERE e.contact_id = ? ORDER BY e.enrolled_at DESC`,
      contactId,
    );
  }

  // ---------------------------------------------------------------- automation hooks

  private onTagAdded(contactId: number, tagId: number): void {
    const sequences = this.core.db.all<{ id: number }>(
      "SELECT id FROM sequences WHERE active = 1 AND json_extract(trigger, '$.type') = 'tag_added' AND json_extract(trigger, '$.tagId') = ?",
      tagId,
    );
    for (const seq of sequences) this.enroll(seq.id, [contactId]);
  }

  private onConsentChanged(contactId: number, to: string): void {
    if (to === 'opted_out') {
      this.core.db.run(
        "UPDATE sequence_enrollments SET status = 'stopped', stop_reason = 'opted_out', next_run_at = NULL, updated_at = ? WHERE contact_id = ? AND status IN ('active', 'sending')",
        this.now(),
        contactId,
      );
      return;
    }
    if (to === 'opted_in') {
      const sequences = this.core.db.all<{ id: number }>(
        "SELECT id FROM sequences WHERE active = 1 AND json_extract(trigger, '$.type') = 'opted_in'",
      );
      for (const seq of sequences) this.enroll(seq.id, [contactId]);
    }
  }

  private onReplied(contactId: number): void {
    this.core.db.run(
      `UPDATE sequence_enrollments SET status = 'stopped', stop_reason = 'replied', next_run_at = NULL, updated_at = ?
        WHERE contact_id = ? AND status = 'active'
          AND sequence_id IN (SELECT id FROM sequences WHERE COALESCE(json_extract(options, '$.stopOnReply'), 1) = 1)`,
      this.now(),
      contactId,
    );
  }

  // ---------------------------------------------------------------- dispatcher support

  /** Due enrollments for a session. During quiet hours only sequences that ignore them qualify. */
  due(sessionId: string, defaultSessionId: string | null, quietNow: boolean, limit = 20): EnrollmentRow[] {
    return this.core.db.all<EnrollmentRow>(
      `SELECT e.* FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
        WHERE e.status = 'active' AND e.next_run_at <= ? AND s.active = 1
          AND COALESCE(s.session_id, ?) = ?
          ${quietNow ? "AND COALESCE(json_extract(s.options, '$.respectQuietHours'), 1) = 0" : ''}
        ORDER BY e.next_run_at LIMIT ?`,
      this.now(),
      defaultSessionId,
      sessionId,
      limit,
    );
  }

  claim(enrollmentId: number): boolean {
    return (
      this.core.db.run("UPDATE sequence_enrollments SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'active'", this.now(), enrollmentId)
        .changes === 1
    );
  }

  /** Mark the current step done and schedule the next one (or finish). */
  advance(enrollment: EnrollmentRow, sequence: Sequence): void {
    const nextStep = enrollment.current_step + 1;
    if (nextStep >= sequence.steps.length) {
      this.core.db.run(
        "UPDATE sequence_enrollments SET status = 'completed', current_step = ?, next_run_at = NULL, updated_at = ? WHERE id = ?",
        nextStep,
        this.now(),
        enrollment.id,
      );
      return;
    }
    const nextRun = nowIso(new Date(this.core.clock().getTime() + sequence.steps[nextStep].delayMinutes * 60_000));
    this.core.db.run(
      "UPDATE sequence_enrollments SET status = 'active', current_step = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      nextStep,
      nextRun,
      this.now(),
      enrollment.id,
    );
  }

  release(enrollmentId: number): void {
    this.core.db.run("UPDATE sequence_enrollments SET status = 'active', updated_at = ? WHERE id = ? AND status = 'sending'", this.now(), enrollmentId);
  }

  render(sequence: Sequence, step: Step, contact: ContactRow): string {
    const settings = this.settings.get();
    let text = renderTemplate(step.body, contactVariables(toContact(contact), { business_name: settings.businessName })).text;
    const footer = settings.compliance.optOutFooter.trim();
    if (sequence.options.appendOptOut && footer) text = text.trim() ? `${text.trimEnd()}\n\n${footer}` : footer;
    return text;
  }
}
