/**
 * Schema migrations, applied in order and tracked with PRAGMA user_version.
 * Never edit a migration that has shipped; append a new one instead.
 *
 * Conventions: timestamps are ISO-8601 UTC strings (lexically sortable), JSON lives in TEXT columns,
 * phone numbers are stored as E.164 digits without the leading '+'.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    email TEXT,
    attributes TEXT NOT NULL DEFAULT '{}',
    consent TEXT NOT NULL DEFAULT 'unknown' CHECK (consent IN ('opted_in', 'unknown', 'opted_out')),
    consent_source TEXT,
    consent_at TEXT,
    wa_status TEXT NOT NULL DEFAULT 'unknown' CHECK (wa_status IN ('unknown', 'valid', 'invalid')),
    wa_chat_id TEXT,
    wa_checked_at TEXT,
    wa_check_requested_at TEXT,
    source TEXT,
    last_inbound_at TEXT,
    last_outbound_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX contacts_consent ON contacts (consent);
  CREATE INDEX contacts_wa_chat_id ON contacts (wa_chat_id);
  CREATE INDEX contacts_check_queue ON contacts (wa_check_requested_at) WHERE wa_check_requested_at IS NOT NULL;
  CREATE INDEX contacts_created ON contacts (created_at);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT '#128C7E',
    created_at TEXT NOT NULL
  );

  CREATE TABLE contact_tags (
    contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (contact_id, tag_id)
  );
  CREATE INDEX contact_tags_tag ON contact_tags (tag_id);

  CREATE TABLE segments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    rules TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE media (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    media_id INTEGER REFERENCES media (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE campaigns (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
    session_id TEXT,
    audience TEXT NOT NULL DEFAULT '{"type":"all"}',
    variants TEXT NOT NULL DEFAULT '[]',
    options TEXT NOT NULL DEFAULT '{}',
    scheduled_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    paused_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX campaigns_status ON campaigns (status);

  CREATE TABLE campaign_recipients (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
    variant TEXT NOT NULL DEFAULT 'A',
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'unknown')),
    token TEXT NOT NULL UNIQUE,
    wa_message_id TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    replied_at TEXT,
    clicked_at TEXT,
    opted_out_at TEXT,
    failed_at TEXT,
    UNIQUE (campaign_id, contact_id)
  );
  CREATE INDEX campaign_recipients_status ON campaign_recipients (campaign_id, status);
  CREATE INDEX campaign_recipients_contact ON campaign_recipients (contact_id, sent_at);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    contact_id INTEGER REFERENCES contacts (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    wa_message_id TEXT,
    type TEXT NOT NULL DEFAULT 'text',
    body TEXT,
    media_id INTEGER REFERENCES media (id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id INTEGER,
    recipient_id INTEGER REFERENCES campaign_recipients (id) ON DELETE SET NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX messages_wa_id ON messages (session_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
  CREATE INDEX messages_contact ON messages (contact_id, created_at);
  CREATE INDEX messages_session_day ON messages (session_id, direction, created_at);
  CREATE INDEX messages_created ON messages (created_at);

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    contact_id INTEGER REFERENCES contacts (id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    media_id INTEGER REFERENCES media (id) ON DELETE SET NULL,
    source_type TEXT NOT NULL,
    source_id INTEGER,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX outbox_due ON outbox (session_id, status, not_before);

  CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    campaign_id INTEGER REFERENCES campaigns (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX links_campaign ON links (campaign_id);

  CREATE TABLE link_clicks (
    id INTEGER PRIMARY KEY,
    link_id INTEGER NOT NULL REFERENCES links (id) ON DELETE CASCADE,
    recipient_id INTEGER REFERENCES campaign_recipients (id) ON DELETE SET NULL,
    user_agent TEXT,
    clicked_at TEXT NOT NULL
  );
  CREATE INDEX link_clicks_link ON link_clicks (link_id);

  CREATE TABLE auto_replies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 100,
    match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'contains', 'starts_with', 'regex', 'any')),
    keywords TEXT NOT NULL DEFAULT '[]',
    reply_body TEXT NOT NULL DEFAULT '',
    reply_media_id INTEGER REFERENCES media (id) ON DELETE SET NULL,
    actions TEXT NOT NULL DEFAULT '{}',
    session_id TEXT,
    cooldown_minutes INTEGER NOT NULL DEFAULT 60,
    hit_count INTEGER NOT NULL DEFAULT 0,
    last_hit_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE auto_reply_hits (
    rule_id INTEGER NOT NULL REFERENCES auto_replies (id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
    hit_at TEXT NOT NULL
  );
  CREATE INDEX auto_reply_hits_lookup ON auto_reply_hits (rule_id, contact_id, hit_at);

  CREATE TABLE sequences (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    session_id TEXT,
    trigger TEXT NOT NULL DEFAULT '{"type":"manual"}',
    steps TEXT NOT NULL DEFAULT '[]',
    options TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sequence_enrollments (
    id INTEGER PRIMARY KEY,
    sequence_id INTEGER NOT NULL REFERENCES sequences (id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sending', 'completed', 'stopped')),
    current_step INTEGER NOT NULL DEFAULT 0,
    next_run_at TEXT,
    stop_reason TEXT,
    enrolled_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (sequence_id, contact_id)
  );
  CREATE INDEX sequence_enrollments_due ON sequence_enrollments (status, next_run_at);
  CREATE INDEX sequence_enrollments_contact ON sequence_enrollments (contact_id);

  CREATE TABLE webhook_receipts (
    idempotency_key TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  );
  CREATE INDEX webhook_receipts_age ON webhook_receipts (received_at);
  `,
  `
  CREATE TABLE owned_sessions (
    session_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Opt-outs outlive deletion: a deleted contact who had unsubscribed is remembered only as a keyed
  -- hash of the number, so a later import or API call can't quietly re-subscribe them.
  CREATE TABLE suppressed_phones (
    phone_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Numbers connected through Meta's official WhatsApp Cloud API. The id doubles as the session id
  -- used everywhere else (campaigns, messages, outbox). Credentials are encrypted (lib/secret-box).
  CREATE TABLE official_numbers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone_number_id TEXT NOT NULL UNIQUE,
    waba_id TEXT NOT NULL,
    display_phone TEXT,
    verified_name TEXT,
    quality_rating TEXT,
    access_token TEXT NOT NULL,
    app_secret TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'failed')),
    last_error TEXT,
    webhook_seen_at TEXT,
    checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Approved (and pending/rejected) templates, synced from Meta per WhatsApp Business Account.
  CREATE TABLE official_templates (
    id INTEGER PRIMARY KEY,
    waba_id TEXT NOT NULL,
    meta_id TEXT,
    name TEXT NOT NULL,
    language TEXT NOT NULL,
    status TEXT NOT NULL,
    category TEXT,
    components TEXT NOT NULL DEFAULT '[]',
    synced_at TEXT NOT NULL,
    UNIQUE (waba_id, name, language)
  );

  -- Media uploaded to Meta is reusable for 30 days; remember the id instead of re-uploading per message.
  CREATE TABLE official_media (
    number_id TEXT NOT NULL REFERENCES official_numbers (id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    meta_media_id TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    PRIMARY KEY (number_id, media_id)
  );
  CREATE INDEX messages_window ON messages (session_id, chat_id, direction, created_at);
  `,
];
