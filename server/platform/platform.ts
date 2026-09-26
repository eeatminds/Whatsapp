import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Core, Logger } from '../context.js';
import { openDatabase, nowIso, parseJson, type Db } from '../db/database.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import type { OpenWAApi, OpenWASession } from '../openwa/client.js';
import { createServices, type Services } from '../services/index.js';
import type { SessionScope } from '../services/sessions.js';
import { MARKETING_SOURCES } from '../services/messages.js';
import { seedStarterKit } from '../services/starter-kit.js';
import { settingsSchema, type Settings } from '../services/settings.js';
import { PLATFORM_MIGRATIONS } from './schema.js';
import { hashPassword, temporaryPassword, verifyPassword } from './passwords.js';

/**
 * The SaaS layer. One platform database holds businesses ("tenants"), their users and payments.
 * Each business gets its own SQLite database, media folder, sending engine and webhook URL, and
 * sees only the WhatsApp numbers it created on the shared OpenWA gateway.
 */

export type Role = 'platform_admin' | 'owner' | 'member';
export type Access = 'active' | 'grace' | 'expired' | 'suspended';

export interface UserRow {
  id: number;
  email: string;
  name: string | null;
  password_hash: string;
  role: Role;
  tenant_id: string | null;
  disabled: number;
  session_version: number;
  last_login_at: string | null;
  created_at: string;
}

export interface TenantRow {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  plan_name: string;
  price_monthly: number;
  paid_until: string;
  max_numbers: number;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  api_key_hash: string | null;
  api_key_prefix: string | null;
  created_at: string;
  updated_at: string;
}

export interface Tenant {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  access: Access;
  planName: string;
  priceMonthly: number;
  paidUntil: string;
  daysLeft: number;
  maxNumbers: number;
  contactName: string | null;
  contactPhone: string | null;
  notes: string | null;
  apiKeyPrefix: string | null;
  createdAt: string;
}

export interface PublicUser {
  id: number;
  email: string;
  name: string | null;
  role: Role;
  tenantId: string | null;
  disabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export const platformSettingsSchema = z.object({
  brandName: z.string().trim().min(1).max(40),
  supportContact: z.string().trim().max(200),
  currencySymbol: z.string().trim().min(1).max(4),
  defaultPrice: z.coerce.number().int().min(0).max(10_000_000),
  defaultMaxNumbers: z.coerce.number().int().min(1).max(100),
  trialDays: z.coerce.number().int().min(0).max(90),
  graceDays: z.coerce.number().int().min(0).max(30),
  /** Starting sending limits for a new business; the admin raises them per business over time. */
  defaultDailyCap: z.coerce.number().int().min(1).max(100_000),
  defaultPerMinuteCap: z.coerce.number().int().min(1).max(60),
});
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

const DEFAULT_SETTINGS: PlatformSettings = {
  brandName: 'WA Reach',
  supportContact: '',
  currencySymbol: '₹',
  defaultPrice: 1000,
  defaultMaxNumbers: 1,
  trialDays: 7,
  graceDays: 3,
  defaultDailyCap: 250,
  defaultPerMinuteCap: 10,
};

/** Sending limits only the platform admin may change (per business). */
export type SendingLimits = Settings['sending'];
const sendingLimitsSchema = settingsSchema.shape.sending.partial();

/** Computed once; checking a password against it costs the same as against a real user's hash. */
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(8, 'Passwords need at least 8 characters').max(200);

export const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(80),
  ownerEmail: email,
  ownerName: z.string().trim().max(80).optional(),
  ownerPassword: password.optional(),
  priceMonthly: z.coerce.number().int().min(0).max(10_000_000).optional(),
  maxNumbers: z.coerce.number().int().min(1).max(100).optional(),
  /** Free days before the first payment is due. */
  trialDays: z.coerce.number().int().min(0).max(365).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  planName: z.string().trim().min(1).max(40).optional(),
  priceMonthly: z.coerce.number().int().min(0).max(10_000_000).optional(),
  maxNumbers: z.coerce.number().int().min(1).max(100).optional(),
  paidUntil: z.iso.datetime({ offset: true }).optional(),
  contactName: z.string().trim().max(80).nullish(),
  contactPhone: z.string().trim().max(40).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

export const paymentSchema = z.object({
  months: z.coerce.number().int().min(1).max(36),
  amount: z.coerce.number().int().min(0).max(100_000_000),
  method: z.enum(['upi', 'cash', 'bank_transfer', 'card', 'other']),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

export const addUserSchema = z.object({
  email,
  name: z.string().trim().max(80).optional(),
  role: z.enum(['owner', 'member']).default('member'),
  password: password.optional(),
});

const DAY = 86_400_000;

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCMonth(next.getUTCMonth() + months);
  // 31 Jan + 1 month lands on 3 Mar; clamp to the last day of February instead.
  if (next.getUTCDate() < day) next.setUTCDate(0);
  return next;
}

function tenantId(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  for (const byte of randomBytes(6)) id += alphabet[byte % alphabet.length];
  return id;
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    tenantId: row.tenant_id,
    disabled: !!row.disabled,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export interface TenantRuntime {
  tenantId: string;
  core: Core;
  services: Services;
  scope: SessionScope;
  running: boolean;
}

export interface PlatformOptions {
  config: AppConfig;
  openwa: OpenWAApi;
  clock?: () => Date;
  log: Logger;
  /** Platform database; defaults to DATA_DIR/platform.sqlite (':memory:' when the app DB is). */
  db?: Db;
  random?: () => number;
  /** Add the ready-made templates and switched-off automations to each business (default true). */
  starterKit?: boolean;
}

export class Platform {
  readonly db: Db;
  readonly config: AppConfig;
  readonly clock: () => Date;
  private readonly openwa: OpenWAApi;
  private readonly log: Logger;
  private readonly random?: () => number;
  private readonly starterKit: boolean;
  private readonly runtimes = new Map<string, TenantRuntime>();
  private gatewayCache: { at: number; sessions: OpenWASession[] } | null = null;
  private gatewayFetch: Promise<OpenWASession[]> | null = null;
  private supervisor: NodeJS.Timeout | null = null;

  constructor(options: PlatformOptions) {
    this.config = options.config;
    this.openwa = options.openwa;
    this.clock = options.clock ?? (() => new Date());
    this.log = options.log;
    this.random = options.random;
    this.starterKit = options.starterKit ?? true;
    const inMemory = options.config.dbPath === ':memory:';
    this.db = options.db ?? openDatabase(inMemory ? ':memory:' : join(options.config.dataDir, 'platform.sqlite'), PLATFORM_MIGRATIONS);
  }

  private now(): string {
    return nowIso(this.clock());
  }

  // ---------------------------------------------------------------- settings

  settings(): PlatformSettings {
    const row = this.db.get<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'platform'");
    const parsed = platformSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...parseJson(row?.value, {}) });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  updateSettings(patch: unknown): PlatformSettings {
    const next = platformSettingsSchema.parse({ ...this.settings(), ...(patch as object) });
    this.db.run(
      "INSERT INTO platform_settings (key, value) VALUES ('platform', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      JSON.stringify(next),
    );
    return next;
  }

  // ---------------------------------------------------------------- users + auth

  /** Create the first platform admin from ADMIN_EMAIL / ADMIN_PASSWORD when none exists. */
  bootstrapAdmin(adminEmail: string, adminPassword: string): void {
    const existing = this.db.get("SELECT 1 FROM users WHERE role = 'platform_admin' LIMIT 1");
    if (existing) return;
    this.db.run(
      "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'Platform admin', ?, 'platform_admin', ?)",
      adminEmail.trim().toLowerCase(),
      hashPassword(adminPassword),
      this.now(),
    );
    this.log.info(`Created platform admin ${adminEmail}`);
  }

  authenticate(emailAddress: string, passwordText: string): UserRow | null {
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE email = ?', emailAddress.trim().toLowerCase());
    // Verify against a dummy hash when the user is missing, so response time doesn't reveal which emails exist.
    const ok = verifyPassword(passwordText, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled) return null;
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', this.now(), user.id);
    return user;
  }

  user(userId: number): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  }

  private assertEmailFree(address: string): void {
    if (this.db.get('SELECT 1 FROM users WHERE email = ?', address)) throw conflict(`${address} already has an account`);
  }

  addUser(tenant: string, input: unknown): { user: PublicUser; password: string } {
    this.tenantRow(tenant);
    const data = addUserSchema.parse(input);
    this.assertEmailFree(data.email);
    const plain = data.password ?? temporaryPassword();
    const id = this.db.run(
      'INSERT INTO users (email, name, password_hash, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      data.email,
      data.name ?? null,
      hashPassword(plain),
      data.role,
      tenant,
      this.now(),
    ).lastInsertRowid;
    return { user: toPublicUser(this.user(id)!), password: plain };
  }

  users(tenant: string): PublicUser[] {
    return this.db.all<UserRow>('SELECT * FROM users WHERE tenant_id = ? ORDER BY role, email', tenant).map(toPublicUser);
  }

  /** Set a new password (generated when omitted) and sign the user out everywhere. */
  resetPassword(userId: number, newPassword?: string): string {
    const user = this.user(userId);
    if (!user) throw notFound('User');
    const plain = newPassword ? password.parse(newPassword) : temporaryPassword();
    this.db.run('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', hashPassword(plain), userId);
    return plain;
  }

  changeOwnPassword(userId: number, current: string, next: string): void {
    const user = this.user(userId);
    if (!user || !verifyPassword(current, user.password_hash)) throw badRequest('Your current password is not correct');
    this.resetPassword(userId, next);
  }

  setUserDisabled(userId: number, disabled: boolean): void {
    const user = this.user(userId);
    if (!user) throw notFound('User');
    if (user.role === 'platform_admin') throw badRequest('Platform admins cannot be disabled here');
    this.db.run('UPDATE users SET disabled = ?, session_version = session_version + 1 WHERE id = ?', disabled, userId);
  }

  deleteUser(userId: number): void {
    const user = this.user(userId);
    if (!user) throw notFound('User');
    if (user.role === 'platform_admin') throw badRequest('Platform admins cannot be deleted here');
    this.db.run('DELETE FROM users WHERE id = ?', userId);
  }

  // ---------------------------------------------------------------- tenants

  accessOf(row: Pick<TenantRow, 'status' | 'paid_until'>): Access {
    if (row.status === 'suspended') return 'suspended';
    const now = this.clock().getTime();
    const until = new Date(row.paid_until).getTime();
    if (now <= until) return 'active';
    if (now <= until + this.settings().graceDays * DAY) return 'grace';
    return 'expired';
  }

  /** Sending is allowed while active and during the grace period after the paid date. */
  canSend(tenant: string): boolean {
    const row = this.db.get<TenantRow>('SELECT * FROM tenants WHERE id = ?', tenant);
    if (!row) return false;
    const access = this.accessOf(row);
    return access === 'active' || access === 'grace';
  }

  private toTenant(row: TenantRow): Tenant {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      access: this.accessOf(row),
      planName: row.plan_name,
      priceMonthly: row.price_monthly,
      paidUntil: row.paid_until,
      daysLeft: Math.ceil((new Date(row.paid_until).getTime() - this.clock().getTime()) / DAY),
      maxNumbers: row.max_numbers,
      contactName: row.contact_name,
      contactPhone: row.contact_phone,
      notes: row.notes,
      apiKeyPrefix: row.api_key_prefix,
      createdAt: row.created_at,
    };
  }

  tenantRow(tenant: string): TenantRow {
    const row = this.db.get<TenantRow>('SELECT * FROM tenants WHERE id = ?', tenant);
    if (!row) throw notFound('Business');
    return row;
  }

  tenant(tenant: string): Tenant {
    return this.toTenant(this.tenantRow(tenant));
  }

  tenants(): Tenant[] {
    return this.db.all<TenantRow>('SELECT * FROM tenants ORDER BY name COLLATE NOCASE').map(r => this.toTenant(r));
  }

  createTenant(input: unknown): { tenant: Tenant; owner: PublicUser; password: string } {
    const data = createTenantSchema.parse(input);
    this.assertEmailFree(data.ownerEmail);
    const settings = this.settings();
    const id = tenantId();
    const now = this.clock();
    const trialDays = data.trialDays ?? settings.trialDays;
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO tenants (id, name, status, plan_name, price_monthly, paid_until, max_numbers, contact_name, contact_phone, notes, created_at, updated_at)
         VALUES (?, ?, 'active', 'Standard', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        data.name,
        data.priceMonthly ?? settings.defaultPrice,
        nowIso(new Date(now.getTime() + trialDays * DAY)),
        data.maxNumbers ?? settings.defaultMaxNumbers,
        data.ownerName ?? null,
        data.contactPhone ?? null,
        data.notes ?? null,
        nowIso(now),
        nowIso(now),
      );
    });
    const { user, password: plain } = this.addUser(id, { email: data.ownerEmail, name: data.ownerName, role: 'owner', password: data.ownerPassword });
    const runtime = this.runtime(id);
    runtime.services.settings.update({
      businessName: data.name,
      sending: {
        dailyCapPerSession: settings.defaultDailyCap,
        sessionMaxPerMinute: settings.defaultPerMinuteCap,
        defaultPerMinute: Math.min(runtime.services.settings.get().sending.defaultPerMinute, settings.defaultPerMinuteCap),
      },
    });
    if (this.supervisor) this.reconcile();
    return { tenant: this.tenant(id), owner: user, password: plain };
  }

  sendingLimits(tenant: string): SendingLimits {
    this.tenantRow(tenant);
    return this.runtime(tenant).services.settings.get().sending;
  }

  setSendingLimits(tenant: string, input: unknown): SendingLimits {
    this.tenantRow(tenant);
    const patch = sendingLimitsSchema.parse(input);
    const settings = this.runtime(tenant).services.settings;
    const next = { ...settings.get().sending, ...patch };
    // A default campaign pace above the per-number ceiling would never be reached; keep them consistent.
    next.defaultPerMinute = Math.min(next.defaultPerMinute, next.sessionMaxPerMinute);
    return settings.update({ sending: next }).sending;
  }

  updateTenant(tenant: string, input: unknown): Tenant {
    this.tenantRow(tenant);
    const data = updateTenantSchema.parse(input);
    const fields: Array<[string, unknown]> = [];
    if (data.name !== undefined) fields.push(['name', data.name]);
    if (data.planName !== undefined) fields.push(['plan_name', data.planName]);
    if (data.priceMonthly !== undefined) fields.push(['price_monthly', data.priceMonthly]);
    if (data.maxNumbers !== undefined) fields.push(['max_numbers', data.maxNumbers]);
    if (data.paidUntil !== undefined) fields.push(['paid_until', nowIso(new Date(data.paidUntil))]);
    if (data.contactName !== undefined) fields.push(['contact_name', data.contactName ?? null]);
    if (data.contactPhone !== undefined) fields.push(['contact_phone', data.contactPhone ?? null]);
    if (data.notes !== undefined) fields.push(['notes', data.notes ?? null]);
    for (const [column, value] of fields) {
      this.db.run(`UPDATE tenants SET ${column} = ?, updated_at = ? WHERE id = ?`, value as string | number | null, this.now(), tenant);
    }
    this.reconcile();
    return this.tenant(tenant);
  }

  setStatus(tenant: string, status: 'active' | 'suspended'): Tenant {
    this.tenantRow(tenant);
    this.db.run('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?', status, this.now(), tenant);
    this.reconcile();
    return this.tenant(tenant);
  }

  /** Record a payment and extend "paid until" from today or from the current end, whichever is later. */
  recordPayment(tenant: string, input: unknown, recordedBy: number | null) {
    const row = this.tenantRow(tenant);
    const data = paymentSchema.parse(input);
    const now = this.clock();
    const start = new Date(Math.max(now.getTime(), new Date(row.paid_until).getTime()));
    const end = addMonths(start, data.months);
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO payments (tenant_id, amount, months, method, reference, note, period_start, period_end, recorded_by, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        tenant,
        data.amount,
        data.months,
        data.method,
        data.reference ?? null,
        data.note ?? null,
        nowIso(start),
        nowIso(end),
        recordedBy,
        nowIso(now),
      );
      this.db.run('UPDATE tenants SET paid_until = ?, updated_at = ? WHERE id = ?', nowIso(end), nowIso(now), tenant);
    });
    this.reconcile();
    return this.tenant(tenant);
  }

  payments(filter: { tenantId?: string; limit?: number } = {}) {
    const rows = this.db.all<Record<string, string | number | null>>(
      `SELECT p.*, t.name AS tenant_name, u.email AS recorded_by_email FROM payments p
         JOIN tenants t ON t.id = p.tenant_id LEFT JOIN users u ON u.id = p.recorded_by
        WHERE (? IS NULL OR p.tenant_id = ?) ORDER BY p.paid_at DESC, p.id DESC LIMIT ?`,
      filter.tenantId ?? null,
      filter.tenantId ?? null,
      Math.min(filter.limit ?? 200, 1000),
    );
    return rows.map(r => ({
      id: Number(r.id),
      tenantId: String(r.tenant_id),
      tenantName: String(r.tenant_name),
      amount: Number(r.amount),
      months: Number(r.months),
      method: String(r.method),
      reference: r.reference as string | null,
      note: r.note as string | null,
      periodStart: String(r.period_start),
      periodEnd: String(r.period_end),
      recordedBy: r.recorded_by_email as string | null,
      paidAt: String(r.paid_at),
    }));
  }

  /** Remove a business: its sessions on the gateway, its data, its users and payments. */
  async deleteTenant(tenant: string): Promise<void> {
    this.tenantRow(tenant);
    const runtime = this.runtime(tenant);
    await runtime.services.dispatcher.stop();
    for (const sessionId of [...this.ownedSessions(runtime)]) {
      await this.openwa.deleteSession(sessionId).catch(error => this.log.warn(`Could not delete session ${sessionId}: ${String(error)}`));
    }
    runtime.core.db.close();
    this.runtimes.delete(tenant);
    this.db.run('DELETE FROM tenants WHERE id = ?', tenant);
    if (runtime.core.config.dbPath !== ':memory:') rmSync(join(this.config.dataDir, 'tenants', tenant), { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- API keys

  rotateApiKey(tenant: string): string {
    this.tenantRow(tenant);
    const key = `wr_${tenant}_${randomBytes(24).toString('base64url')}`;
    this.db.run('UPDATE tenants SET api_key_hash = ?, api_key_prefix = ?, updated_at = ? WHERE id = ?', hashApiKey(key), key.slice(0, 14), this.now(), tenant);
    return key;
  }

  revokeApiKey(tenant: string): void {
    this.db.run('UPDATE tenants SET api_key_hash = NULL, api_key_prefix = NULL WHERE id = ?', tenant);
  }

  tenantByApiKey(key: string): string | null {
    if (!key.startsWith('wr_')) return null;
    return this.db.get<{ id: string }>('SELECT id FROM tenants WHERE api_key_hash = ?', hashApiKey(key))?.id ?? null;
  }

  // ---------------------------------------------------------------- per-business runtime

  private ownedSessions(runtime: Pick<TenantRuntime, 'core'>): Set<string> {
    return new Set(runtime.core.db.all<{ session_id: string }>('SELECT session_id FROM owned_sessions').map(r => r.session_id));
  }

  /** Every session on the gateway, fetched once for all businesses (10 s cache). */
  async fetchAllSessions(force = false): Promise<OpenWASession[]> {
    if (!force && this.gatewayCache && Date.now() - this.gatewayCache.at < 10_000) return this.gatewayCache.sessions;
    if (this.gatewayFetch) return this.gatewayFetch;
    this.gatewayFetch = this.openwa
      .listSessions()
      .then(sessions => {
        this.gatewayCache = { at: Date.now(), sessions: Array.isArray(sessions) ? sessions : [] };
        return this.gatewayCache.sessions;
      })
      .finally(() => {
        this.gatewayFetch = null;
      });
    return this.gatewayFetch;
  }

  runtime(tenant: string): TenantRuntime {
    const existing = this.runtimes.get(tenant);
    if (existing) return existing;
    this.tenantRow(tenant);
    const inMemory = this.config.dbPath === ':memory:';
    const dir = join(this.config.dataDir, 'tenants', tenant);
    const mediaDir = join(dir, 'media');
    mkdirSync(mediaDir, { recursive: true });
    const config: AppConfig = {
      ...this.config,
      dbPath: inMemory ? ':memory:' : join(dir, 'wa-reach.sqlite'),
      mediaDir,
      webhookUrl: `${this.config.webhookUrl}/${tenant}`,
      publicUrl: this.config.publicUrl ? `${this.config.publicUrl}/t/${tenant}` : null,
      apiKey: null,
    };
    const core: Core = { db: openDatabase(config.dbPath), config, openwa: this.openwa, clock: this.clock, log: this.log };
    const owned = this.ownedSessions({ core });
    const scope: SessionScope = {
      fetchAll: force => this.fetchAllSessions(force),
      owns: id => owned.has(id),
      add: id => {
        owned.add(id);
        core.db.run('INSERT OR IGNORE INTO owned_sessions (session_id, created_at) VALUES (?, ?)', id, this.now());
        this.gatewayCache = null;
      },
      remove: id => {
        owned.delete(id);
        core.db.run('DELETE FROM owned_sessions WHERE session_id = ?', id);
        this.gatewayCache = null;
      },
      namePrefix: `${tenant}-`,
      maxNumbers: () => this.db.get<{ max_numbers: number }>('SELECT max_numbers FROM tenants WHERE id = ?', tenant)?.max_numbers ?? 1,
    };
    const services = createServices(core, { random: this.random, scope });
    if (this.starterKit) {
      try {
        seedStarterKit(core.db, services, this.now());
      } catch (error) {
        this.log.warn(`Could not add the starter kit for ${tenant}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const runtime: TenantRuntime = { tenantId: tenant, core, services, scope, running: false };
    this.runtimes.set(tenant, runtime);
    services.dispatcher.recover();
    return runtime;
  }

  /** Start sending engines for paid-up businesses and stop them for lapsed or suspended ones. */
  reconcile(): void {
    if (!this.supervisor) return;
    for (const row of this.db.all<TenantRow>('SELECT * FROM tenants')) {
      const runtime = this.runtime(row.id);
      const shouldRun = this.canSend(row.id);
      if (shouldRun && !runtime.running) {
        runtime.services.dispatcher.start();
        runtime.running = true;
        void runtime.services.sessions.syncWebhooks().catch(() => undefined);
      } else if (!shouldRun && runtime.running) {
        void runtime.services.dispatcher.stop();
        runtime.running = false;
        this.log.info(`Sending paused for ${row.name}: ${this.accessOf(row)}`);
      }
    }
  }

  start(): void {
    if (this.supervisor) return;
    this.supervisor = setInterval(() => this.reconcile(), 60_000);
    this.supervisor.unref?.();
    this.reconcile();
  }

  async stop(): Promise<void> {
    if (this.supervisor) clearInterval(this.supervisor);
    this.supervisor = null;
    for (const runtime of this.runtimes.values()) await runtime.services.dispatcher.stop();
  }

  close(): void {
    for (const runtime of this.runtimes.values()) runtime.core.db.close();
    this.runtimes.clear();
    this.db.close();
  }

  // ---------------------------------------------------------------- admin overview

  tenantStats(tenant: string) {
    const runtime = this.runtime(tenant);
    const monthStart = new Date(this.clock());
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const db = runtime.core.db;
    return {
      numbers: this.ownedSessions(runtime).size,
      contacts: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts')?.n ?? 0,
      sentThisMonth:
        db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND source_type IN ${MARKETING_SOURCES} AND created_at >= ?`,
          nowIso(monthStart),
        )?.n ?? 0,
      campaigns: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM campaigns')?.n ?? 0,
    };
  }

  overview() {
    const tenants = this.tenants();
    const paying = tenants.filter(t => t.access === 'active' || t.access === 'grace');
    const monthStart = new Date(this.clock());
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const collected =
      this.db.get<{ total: number }>('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE paid_at >= ?', nowIso(monthStart))?.total ?? 0;
    const now = this.clock().getTime();
    return {
      businesses: tenants.length,
      active: paying.length,
      suspended: tenants.filter(t => t.access === 'suspended').length,
      expired: tenants.filter(t => t.access === 'expired').length,
      inGrace: tenants.filter(t => t.access === 'grace').length,
      monthlyRecurring: paying.reduce((sum, t) => sum + t.priceMonthly, 0),
      collectedThisMonth: collected,
      expiringSoon: tenants
        .filter(t => t.access === 'active' && new Date(t.paidUntil).getTime() - now < 7 * DAY)
        .sort((a, b) => a.paidUntil.localeCompare(b.paidUntil)),
      needsAttention: tenants.filter(t => t.access === 'grace' || t.access === 'expired'),
    };
  }

  /** Throw 402 when a business may not change anything (lapsed or suspended). */
  assertWritable(tenant: string): void {
    const access = this.tenant(tenant).access;
    if (access === 'expired' || access === 'suspended') {
      const contact = this.settings().supportContact;
      throw new HttpError(
        402,
        access === 'suspended'
          ? `This account is suspended.${contact ? ` Contact ${contact}.` : ''}`
          : `Your subscription has expired. Renew to keep sending.${contact ? ` Contact ${contact}.` : ''}`,
      );
    }
  }
}
