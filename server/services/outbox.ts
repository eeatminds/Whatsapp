import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import type { SourceType } from './messages.js';

export interface OutboxRow {
  id: number;
  session_id: string;
  contact_id: number | null;
  chat_id: string;
  body: string;
  media_id: number | null;
  source_type: SourceType;
  source_id: number | null;
  status: string;
  attempts: number;
  not_before: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

export const MAX_OUTBOX_ATTEMPTS = 5;

/**
 * Transactional messages (auto-replies, opt-in/out confirmations). They skip campaign pacing,
 * quiet hours and daily caps because the contact just wrote to us, but still go through the
 * dispatcher so a webhook is acknowledged immediately and sends stay serialized per number.
 */
export class OutboxService {
  constructor(private readonly core: Core) {}

  enqueue(input: {
    sessionId: string;
    contactId: number | null;
    chatId: string;
    body: string;
    mediaId?: number | null;
    sourceType: SourceType;
    sourceId?: number | null;
    delayMs?: number;
  }): number {
    const now = this.core.clock();
    let notBefore = now.getTime() + (input.delayMs ?? 0);
    // Replies to one chat keep their order even though each carries its own random delay.
    const last = this.core.db.get<{ not_before: string }>(
      "SELECT MAX(not_before) AS not_before FROM outbox WHERE session_id = ? AND chat_id = ? AND status = 'queued'",
      input.sessionId,
      input.chatId,
    );
    if (last?.not_before) notBefore = Math.max(notBefore, new Date(last.not_before).getTime() + 1000);
    return this.core.db.run(
      `INSERT INTO outbox (session_id, contact_id, chat_id, body, media_id, source_type, source_id, status, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      input.sessionId,
      input.contactId,
      input.chatId,
      input.body,
      input.mediaId ?? null,
      input.sourceType,
      input.sourceId ?? null,
      nowIso(new Date(notBefore)),
      nowIso(now),
    ).lastInsertRowid;
  }

  nextDue(sessionId: string): OutboxRow | undefined {
    return this.core.db.get<OutboxRow>(
      "SELECT * FROM outbox WHERE session_id = ? AND status = 'queued' AND not_before <= ? ORDER BY not_before, id LIMIT 1",
      sessionId,
      nowIso(this.core.clock()),
    );
  }

  claim(id: number): boolean {
    return this.core.db.run("UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'", id).changes === 1;
  }

  markSent(id: number): void {
    this.core.db.run("UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?", nowIso(this.core.clock()), id);
  }

  markFailed(id: number, error: string): void {
    this.core.db.run("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", error.slice(0, 500), id);
  }

  requeue(id: number, error: string, retryInMs: number): void {
    const row = this.core.db.get<{ attempts: number }>('SELECT attempts FROM outbox WHERE id = ?', id);
    if (row && row.attempts >= MAX_OUTBOX_ATTEMPTS) {
      this.markFailed(id, `Gave up after ${row.attempts} attempts: ${error}`);
      return;
    }
    this.core.db.run(
      "UPDATE outbox SET status = 'queued', error = ?, not_before = ? WHERE id = ?",
      error.slice(0, 500),
      nowIso(new Date(this.core.clock().getTime() + retryInMs)),
      id,
    );
  }

  /** Transactional messages older than a day are no longer a timely reply; drop them. */
  expireStale(): number {
    const cutoff = nowIso(new Date(this.core.clock().getTime() - 24 * 3_600_000));
    return this.core.db.run(
      "UPDATE outbox SET status = 'cancelled', error = 'expired: not sent within 24 hours' WHERE status = 'queued' AND created_at < ?",
      cutoff,
    ).changes;
  }

  pendingCount(): number {
    return this.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE status = 'queued'")?.n ?? 0;
  }
}
