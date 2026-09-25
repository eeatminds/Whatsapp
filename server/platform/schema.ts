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
];
