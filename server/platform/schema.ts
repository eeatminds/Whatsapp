/** Platform database: who can sign in, which businesses exist, and what they have paid. */
export const PLATFORM_MIGRATIONS: string[] = [
  `
  CREATE TABLE platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    plan_name TEXT NOT NULL DEFAULT 'Standard',
    price_monthly INTEGER NOT NULL DEFAULT 1000,
    paid_until TEXT NOT NULL,
    max_numbers INTEGER NOT NULL DEFAULT 1,
    contact_name TEXT,
    contact_phone TEXT,
    notes TEXT,
    api_key_hash TEXT UNIQUE,
    api_key_prefix TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('platform_admin', 'owner', 'member')),
    tenant_id TEXT REFERENCES tenants (id) ON DELETE CASCADE,
    disabled INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX users_tenant ON users (tenant_id);

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    months INTEGER NOT NULL,
    method TEXT NOT NULL,
    reference TEXT,
    note TEXT,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    recorded_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    paid_at TEXT NOT NULL
  );
  CREATE INDEX payments_tenant ON payments (tenant_id, paid_at);
  CREATE INDEX payments_paid_at ON payments (paid_at);
  `,
  // Callers: team members who only work the Leads page. SQLite can't change a CHECK in place, so the
  // users table is rebuilt; dropping it would clear payments.recorded_by, which is put back after.
  `
  CREATE TEMP TABLE keep_recorded_by AS SELECT id, recorded_by FROM payments WHERE recorded_by IS NOT NULL;
  CREATE TABLE users_next (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('platform_admin', 'owner', 'member', 'caller')),
    tenant_id TEXT REFERENCES tenants (id) ON DELETE CASCADE,
    disabled INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    lead_scope TEXT NOT NULL DEFAULT 'assigned' CHECK (lead_scope IN ('assigned', 'all'))
  );
  INSERT INTO users_next (id, email, name, password_hash, role, tenant_id, disabled, session_version, last_login_at, created_at)
    SELECT id, email, name, password_hash, role, tenant_id, disabled, session_version, last_login_at, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_next RENAME TO users;
  CREATE INDEX users_tenant ON users (tenant_id);
  UPDATE payments SET recorded_by = (SELECT k.recorded_by FROM keep_recorded_by k WHERE k.id = payments.id)
    WHERE id IN (SELECT id FROM keep_recorded_by);
  DROP TABLE keep_recorded_by;
  `,
];
