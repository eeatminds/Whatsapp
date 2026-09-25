import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, del, patch, post, put, useApi, errorMessage, type Payment, type PlatformSettings, type PlatformUser, type TenantInfo, type TenantStats } from '../api';
import { SendingLimitsForm, type SendingLimits } from '../components/SendingLimits';
import { Badge, Button, Callout, Card, Drawer, Empty, ErrorNote, Field, Loading, Modal, PageHeader, StatTile, useConfirm, useToast } from '../components/ui';
import { IconCopy, IconPlus, IconSearch } from '../components/icons';
import { useSession, money } from '../session';
import { formatDate, formatDateTime, formatNumber, relativeTime, toLocalInput, fromLocalInput } from '../format';

type TenantRow = TenantInfo & { stats: TenantStats; owner: PlatformUser | null };

export function AccessBadge({ tenant }: { tenant: Pick<TenantInfo, 'access' | 'daysLeft'> }) {
  if (tenant.access === 'suspended') return <Badge tone="red" dot>Suspended</Badge>;
  if (tenant.access === 'expired') return <Badge tone="red" dot>Expired</Badge>;
  if (tenant.access === 'grace') return <Badge tone="amber" dot>Payment due</Badge>;
  if (tenant.daysLeft <= 7) return <Badge tone="amber" dot>{tenant.daysLeft}d left</Badge>;
  return <Badge tone="green" dot>Active</Badge>;
}

const METHODS: Record<string, string> = { upi: 'UPI', cash: 'Cash', bank_transfer: 'Bank transfer', card: 'Card', other: 'Other' };

function CopyText({ text }: { text: string }) {
  const toast = useToast();
  return (
    <span className="row" style={{ gap: 6 }}>
      <code style={{ fontSize: 14, padding: '2px 6px', background: 'var(--surface-sunken)', borderRadius: 4 }}>{text}</code>
      <Button
        size="sm"
        variant="ghost"
        icon={<IconCopy size={14} />}
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          toast.success('Copied');
        }}
      />
    </span>
  );
}

function Credentials({ email, password, loginUrl }: { email: string; password: string; loginUrl: string }) {
  const message = `Your WhatsApp marketing account is ready.\nLogin: ${loginUrl}\nEmail: ${email}\nPassword: ${password}\nPlease change your password after signing in (Account & billing).`;
  return (
    <div className="stack">
      <Callout tone="success">Share these sign-in details with the business owner. The password is shown only once.</Callout>
      <dl className="kv">
        <dt>Login page</dt>
        <dd>
          <CopyText text={loginUrl} />
        </dd>
        <dt>Email</dt>
        <dd>
          <CopyText text={email} />
        </dd>
        <dt>Password</dt>
        <dd>
          <CopyText text={password} />
        </dd>
      </dl>
      <Button
        icon={<IconCopy size={16} />}
        onClick={() => {
          void navigator.clipboard?.writeText(message);
        }}
      >
        Copy as a WhatsApp message
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- overview

export function AdminOverviewPage() {
  const { me } = useSession();
  const navigate = useNavigate();
  const symbol = me.brand.currencySymbol;
  const { data, error, loading } = useApi<{
    businesses: number;
    active: number;
    suspended: number;
    expired: number;
    inGrace: number;
    monthlyRecurring: number;
    collectedThisMonth: number;
    expiringSoon: TenantInfo[];
    needsAttention: TenantInfo[];
    gateway: { reachable: boolean; sessions: number; ready: number; error?: string };
  }>('/api/admin/overview', { poll: 30000 });
  if (loading && !data) return <Loading />;
  return (
    <div className="page">
      <PageHeader
        title="Admin overview"
        description="Your WhatsApp marketing business at a glance."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => navigate('/admin/businesses?new=1')}>
            Add business
          </Button>
        }
      />
      <ErrorNote error={error} />
      {data && (
        <>
          {!data.gateway.reachable && (
            <Callout tone="danger">The OpenWA gateway is unreachable{data.gateway.error ? `: ${data.gateway.error}` : ''}. No business can send until it is back.</Callout>
          )}
          <div className="grid cols-4">
            <StatTile label="Monthly recurring revenue" value={money(symbol, data.monthlyRecurring)} sub={`${data.active} paying businesses`} />
            <StatTile label="Collected this month" value={money(symbol, data.collectedThisMonth)} sub="Payments recorded since the 1st" />
            <StatTile label="Businesses" value={formatNumber(data.businesses)} sub={`${data.inGrace} payment due · ${data.expired} expired · ${data.suspended} suspended`} />
            <StatTile label="WhatsApp numbers" value={`${data.gateway.ready} / ${data.gateway.sessions}`} sub="Connected / total on the gateway" />
          </div>
          <div className="grid cols-2">
            <Card title="Renewals due this week" bodyClass="">
              {data.expiringSoon.length === 0 ? (
                <p className="muted" style={{ padding: '16px 20px' }}>
                  Nothing due in the next 7 days.
                </p>
              ) : (
                <TenantMiniTable tenants={data.expiringSoon} symbol={symbol} />
              )}
            </Card>
            <Card title="Needs attention" subtitle="Unpaid past the renewal date" bodyClass="">
              {data.needsAttention.length === 0 ? (
                <p className="muted" style={{ padding: '16px 20px' }}>
                  Everyone is paid up.
                </p>
              ) : (
                <TenantMiniTable tenants={data.needsAttention} symbol={symbol} />
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function TenantMiniTable({ tenants, symbol }: { tenants: TenantInfo[]; symbol: string }) {
  const navigate = useNavigate();
  return (
    <table className="table">
      <tbody>
        {tenants.map(t => (
          <tr key={t.id} className="clickable" onClick={() => navigate(`/admin/businesses?open=${t.id}`)}>
            <td>
              <strong>{t.name}</strong>
              <div className="small secondary">Paid until {formatDate(t.paidUntil)}</div>
            </td>
            <td>
              <AccessBadge tenant={t} />
            </td>
            <td className="num">{money(symbol, t.priceMonthly)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- businesses

function NewBusinessModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { me } = useSession();
  const { data: settings } = useApi<PlatformSettings>('/api/admin/settings');
  const [form, setForm] = useState({ name: '', ownerName: '', ownerEmail: '', contactPhone: '', priceMonthly: '', maxNumbers: '', trialDays: '' });
  const [result, setResult] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: form.name, ownerName: form.ownerName || undefined, ownerEmail: form.ownerEmail, contactPhone: form.contactPhone || undefined };
      if (form.priceMonthly) body.priceMonthly = Number(form.priceMonthly);
      if (form.maxNumbers) body.maxNumbers = Number(form.maxNumbers);
      if (form.trialDays) body.trialDays = Number(form.trialDays);
      const r = await post<{ owner: PlatformUser; password: string }>('/api/admin/tenants', body);
      setResult({ email: r.owner.email, password: r.password });
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={result ? 'Business created' : 'Add a business'}
      onClose={onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!form.name.trim() || !form.ownerEmail.trim()} onClick={create}>
              Create business
            </Button>
          </>
        )
      }
    >
      {result ? (
        <Credentials email={result.email} password={result.password} loginUrl={window.location.origin} />
      ) : (
        <>
          <ErrorNote error={error} />
          <Field label="Business name">
            <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Sharma Salon" />
          </Field>
          <div className="grid cols-2">
            <Field label="Owner name">
              <input className="input" value={form.ownerName} onChange={e => setForm({ ...form, ownerName: e.target.value })} />
            </Field>
            <Field label="Owner email (their login)">
              <input className="input" type="email" value={form.ownerEmail} onChange={e => setForm({ ...form, ownerEmail: e.target.value })} />
            </Field>
            <Field label="Owner phone">
              <input className="input" value={form.contactPhone} onChange={e => setForm({ ...form, contactPhone: e.target.value })} placeholder="+91 …" />
            </Field>
            <Field label={`Monthly price (${me.brand.currencySymbol})`}>
              <input className="input" type="number" min={0} value={form.priceMonthly} placeholder={String(settings?.defaultPrice ?? 1000)} onChange={e => setForm({ ...form, priceMonthly: e.target.value })} />
            </Field>
            <Field label="WhatsApp numbers allowed">
              <input className="input" type="number" min={1} value={form.maxNumbers} placeholder={String(settings?.defaultMaxNumbers ?? 1)} onChange={e => setForm({ ...form, maxNumbers: e.target.value })} />
            </Field>
            <Field label="Free trial (days)" hint="Access starts now; the first payment is due when the trial ends.">
              <input className="input" type="number" min={0} value={form.trialDays} placeholder={String(settings?.trialDays ?? 7)} onChange={e => setForm({ ...form, trialDays: e.target.value })} />
            </Field>
          </div>
          <p className="hint">A temporary password is generated for the owner. You'll see it on the next screen.</p>
        </>
      )}
    </Modal>
  );
}

function PaymentModal({ tenant, onClose, onDone }: { tenant: TenantInfo; onClose: () => void; onDone: () => void }) {
  const { me } = useSession();
  const [months, setMonths] = useState(1);
  const [amount, setAmount] = useState(String(tenant.priceMonthly));
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = new Date(Math.max(Date.now(), new Date(tenant.paidUntil).getTime()));
  const end = new Date(start);
  end.setMonth(end.getMonth() + months);
  return (
    <Modal
      title={`Record payment · ${tenant.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await post(`/api/admin/tenants/${tenant.id}/payments`, { months, amount: Number(amount), method, reference: reference || undefined, note: note || undefined });
                onDone();
                onClose();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Record payment
          </Button>
        </>
      }
    >
      <ErrorNote error={error} />
      <div className="grid cols-2">
        <Field label="Months paid">
          <select
            className="select"
            value={months}
            onChange={e => {
              const m = Number(e.target.value);
              setMonths(m);
              setAmount(String(tenant.priceMonthly * m));
            }}
          >
            {[1, 2, 3, 6, 12].map(m => (
              <option key={m} value={m}>
                {m} month{m > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Amount received (${me.brand.currencySymbol})`}>
          <input className="input" type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} />
        </Field>
        <Field label="Method">
          <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
            {Object.entries(METHODS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference (UPI / transaction id)">
          <input className="input" value={reference} onChange={e => setReference(e.target.value)} />
        </Field>
      </div>
      <Field label="Note (optional)">
        <input className="input" value={note} onChange={e => setNote(e.target.value)} />
      </Field>
      <Callout>
        Access will run until <strong>{formatDate(end.toISOString())}</strong>.
      </Callout>
    </Modal>
  );
}

function BusinessDrawer({ tenantId, onClose, onChanged }: { tenantId: string; onClose: () => void; onChanged: () => void }) {
  const { me, reload: reloadSession } = useSession();
  const symbol = me.brand.currencySymbol;
  const navigate = useNavigate();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const { data, reload } = useApi<{ tenant: TenantInfo; stats: TenantStats; users: PlatformUser[]; payments: Payment[]; sending: SendingLimits }>(`/api/admin/tenants/${tenantId}`);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{ name: string; priceMonthly: string; maxNumbers: string; paidUntil: string; contactPhone: string; notes: string }>({
    name: '',
    priceMonthly: '',
    maxNumbers: '',
    paidUntil: '',
    contactPhone: '',
    notes: '',
  });
  const [newUser, setNewUser] = useState('');
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const [deleteName, setDeleteName] = useState<string | null>(null);

  const refresh = async () => {
    await reload();
    onChanged();
  };
  const act = async (fn: () => Promise<unknown>, message?: string) => {
    try {
      await fn();
      if (message) toast.success(message);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (!data) return <Drawer title="Business" onClose={onClose}><Loading /></Drawer>;
  const { tenant, stats, users, payments } = data;

  return (
    <Drawer
      title={tenant.name}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            onClick={async () => {
              await post(`/api/admin/tenants/${tenant.id}/enter`);
              await reloadSession();
              navigate('/');
            }}
          >
            Open workspace
          </Button>
          <span className="spacer" />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="row wrap">
        <AccessBadge tenant={tenant} />
        <span className="secondary small">Customer since {formatDate(tenant.createdAt)}</span>
      </div>

      <Card
        title="Subscription"
        actions={
          <Button size="sm" variant="primary" onClick={() => setPaying(true)}>
            Record payment
          </Button>
        }
      >
        <dl className="kv">
          <dt>Plan</dt>
          <dd>
            {money(symbol, tenant.priceMonthly)}/month · {tenant.maxNumbers} WhatsApp number{tenant.maxNumbers > 1 ? 's' : ''}
          </dd>
          <dt>Paid until</dt>
          <dd>
            {formatDate(tenant.paidUntil)} <span className="muted">({tenant.daysLeft >= 0 ? `${tenant.daysLeft} days left` : `${-tenant.daysLeft} days overdue`})</span>
          </dd>
          <dt>Usage</dt>
          <dd>
            {stats.numbers} numbers · {formatNumber(stats.contacts)} contacts · {formatNumber(stats.sentThisMonth)} sent this month
          </dd>
          {tenant.contactPhone && (
            <>
              <dt>Phone</dt>
              <dd>{tenant.contactPhone}</dd>
            </>
          )}
          {tenant.notes && (
            <>
              <dt>Notes</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{tenant.notes}</dd>
            </>
          )}
        </dl>
        <div className="row wrap" style={{ marginTop: 14 }}>
          <Button
            size="sm"
            onClick={() => {
              setForm({
                name: tenant.name,
                priceMonthly: String(tenant.priceMonthly),
                maxNumbers: String(tenant.maxNumbers),
                paidUntil: toLocalInput(tenant.paidUntil),
                contactPhone: tenant.contactPhone ?? '',
                notes: tenant.notes ?? '',
              });
              setEditing(true);
            }}
          >
            Edit plan
          </Button>
          {tenant.status === 'active' ? (
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                if (await confirm(`Suspend ${tenant.name}?`, 'They can still sign in and see their data, but nothing is sent and nothing can be changed until you reactivate them.', { confirmLabel: 'Suspend', danger: true }))
                  await act(() => post(`/api/admin/tenants/${tenant.id}/suspend`), 'Suspended');
              }}
            >
              Suspend
            </Button>
          ) : (
            <Button size="sm" onClick={() => act(() => post(`/api/admin/tenants/${tenant.id}/activate`), 'Reactivated')}>
              Reactivate
            </Button>
          )}
        </div>
      </Card>

      <Card title="Sending limits" subtitle="Only you can change these. The business sees them in its Settings.">
        <SendingLimitsForm
          value={data.sending}
          onSave={async next => {
            try {
              await put(`/api/admin/tenants/${tenant.id}/sending`, next);
              toast.success('Sending limits saved');
              void reload();
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        />
      </Card>

      <Card title="Logins" bodyClass="">
        <table className="table">
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td>
                  <strong>{u.email}</strong>
                  <div className="small secondary">
                    {u.role === 'owner' ? 'Owner' : 'Team member'}
                    {u.disabled ? ' · disabled' : ''} · {u.lastLoginAt ? `last seen ${relativeTime(u.lastLoginAt)}` : 'never signed in'}
                  </div>
                </td>
                <td className="right nowrap">
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (!(await confirm(`Reset password for ${u.email}?`, 'A new temporary password is generated and they are signed out everywhere.'))) return;
                      try {
                        const r = await post<{ password: string }>(`/api/admin/tenants/${tenant.id}/users/${u.id}/reset-password`);
                        setCredentials({ email: u.email, password: r.password });
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                  >
                    Reset password
                  </Button>{' '}
                  {u.role !== 'owner' && (
                    <Button size="sm" variant="ghost" onClick={() => act(() => del(`/api/admin/tenants/${tenant.id}/users/${u.id}`), 'Removed')}>
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="row"
          style={{ padding: '12px 14px' }}
          onSubmit={async e => {
            e.preventDefault();
            try {
              const r = await post<{ user: PlatformUser; password: string }>(`/api/admin/tenants/${tenant.id}/users`, { email: newUser, role: 'member' });
              setCredentials({ email: r.user.email, password: r.password });
              setNewUser('');
              await refresh();
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <input className="input sm" type="email" placeholder="Add a team member's email" value={newUser} onChange={e => setNewUser(e.target.value)} />
          <Button size="sm" type="submit" disabled={!newUser}>
            Add
          </Button>
        </form>
      </Card>

      <Card title="Payment history" bodyClass="">
        {payments.length === 0 ? (
          <p className="muted" style={{ padding: '16px 20px' }}>
            No payments recorded yet.
          </p>
        ) : (
          <table className="table">
            <tbody>
              {payments.map(p => (
                <tr key={p.id}>
                  <td>
                    {formatDate(p.paidAt)}
                    <div className="small secondary">
                      {METHODS[p.method] ?? p.method}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </div>
                  </td>
                  <td className="small secondary">
                    {p.months} month{p.months > 1 ? 's' : ''}, to {formatDate(p.periodEnd)}
                  </td>
                  <td className="num">{money(symbol, p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div>
        <Button variant="danger" size="sm" onClick={() => setDeleteName('')}>
          Delete business…
        </Button>
      </div>

      {paying && <PaymentModal tenant={tenant} onClose={() => setPaying(false)} onDone={() => void refresh()} />}
      {credentials && (
        <Modal title="New sign-in details" onClose={() => setCredentials(null)} footer={<Button variant="primary" onClick={() => setCredentials(null)}>Done</Button>}>
          <Credentials email={credentials.email} password={credentials.password} loginUrl={window.location.origin} />
        </Modal>
      )}
      {editing && (
        <Modal
          title="Edit plan"
          onClose={() => setEditing(false)}
          footer={
            <>
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  await act(
                    () =>
                      patch(`/api/admin/tenants/${tenant.id}`, {
                        name: form.name,
                        priceMonthly: Number(form.priceMonthly),
                        maxNumbers: Number(form.maxNumbers),
                        paidUntil: fromLocalInput(form.paidUntil),
                        contactPhone: form.contactPhone || null,
                        notes: form.notes || null,
                      }),
                    'Saved',
                  );
                  setEditing(false);
                }}
              >
                Save
              </Button>
            </>
          }
        >
          <Field label="Business name">
            <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </Field>
          <div className="grid cols-2">
            <Field label={`Monthly price (${symbol})`}>
              <input className="input" type="number" value={form.priceMonthly} onChange={e => setForm({ ...form, priceMonthly: e.target.value })} />
            </Field>
            <Field label="WhatsApp numbers allowed">
              <input className="input" type="number" min={1} value={form.maxNumbers} onChange={e => setForm({ ...form, maxNumbers: e.target.value })} />
            </Field>
            <Field label="Paid until" hint="Adjust by hand, e.g. to give free days.">
              <input className="input" type="datetime-local" value={form.paidUntil} onChange={e => setForm({ ...form, paidUntil: e.target.value })} />
            </Field>
            <Field label="Owner phone">
              <input className="input" value={form.contactPhone} onChange={e => setForm({ ...form, contactPhone: e.target.value })} />
            </Field>
          </div>
          <Field label="Notes (only you see these)">
            <textarea className="textarea" rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </Modal>
      )}
      {deleteName !== null && (
        <Modal
          title={`Delete ${tenant.name}?`}
          onClose={() => setDeleteName(null)}
          footer={
            <>
              <Button onClick={() => setDeleteName(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={deleteName !== tenant.name}
                onClick={async () => {
                  try {
                    await api('DELETE', `/api/admin/tenants/${tenant.id}`, { confirm: deleteName });
                    toast.success('Business deleted');
                    onChanged();
                    onClose();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                Delete forever
              </Button>
            </>
          }
        >
          <Callout tone="danger">This unlinks their WhatsApp numbers and permanently deletes their contacts, campaigns, messages, logins and payment history.</Callout>
          <Field label={`Type ${tenant.name} to confirm`}>
            <input className="input" value={deleteName} onChange={e => setDeleteName(e.target.value)} />
          </Field>
        </Modal>
      )}
      {dialog}
    </Drawer>
  );
}

export function AdminBusinessesPage() {
  const { me } = useSession();
  const symbol = me.brand.currencySymbol;
  const params = new URLSearchParams(window.location.search);
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [open, setOpen] = useState<string | null>(params.get('open'));
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useApi<TenantRow[]>('/api/admin/tenants', { poll: 30000 });
  const rows = (data ?? []).filter(t => !q || t.name.toLowerCase().includes(q.toLowerCase()) || t.owner?.email.includes(q.toLowerCase()));
  return (
    <div className="page">
      <PageHeader
        title="Businesses"
        description="Every customer account, its plan and whether it's paid up."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            Add business
          </Button>
        }
      />
      <ErrorNote error={error} />
      <Card bodyClass="">
        <div className="card-header">
          <div className="row" style={{ position: 'relative', maxWidth: 320, flex: 1 }}>
            <IconSearch size={16} style={{ position: 'absolute', left: 10, color: 'var(--text-muted)' }} />
            <input className="input sm" style={{ paddingLeft: 32 }} placeholder="Search name or email" value={q} onChange={e => setQ(e.target.value)} aria-label="Search businesses" />
          </div>
          <span className="small muted">{data ? `${data.length} businesses` : ''}</span>
        </div>
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title={q ? 'No match' : 'No businesses yet'} action={!q && <Button variant="primary" onClick={() => setCreating(true)}>Add your first business</Button>}>
            {!q && 'Add a business, share the sign-in details with its owner, and record their monthly payment here.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Business</th>
                  <th>Status</th>
                  <th>Paid until</th>
                  <th className="num">Price</th>
                  <th className="num">Numbers</th>
                  <th className="num">Contacts</th>
                  <th className="num">Sent this month</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(t => (
                  <tr key={t.id} className="clickable" onClick={() => setOpen(t.id)}>
                    <td>
                      <strong>{t.name}</strong>
                      <div className="small secondary">{t.owner?.email ?? 'no owner'}</div>
                    </td>
                    <td>
                      <AccessBadge tenant={t} />
                    </td>
                    <td className="nowrap">{formatDate(t.paidUntil)}</td>
                    <td className="num">{money(symbol, t.priceMonthly)}</td>
                    <td className="num">
                      {t.stats.numbers} / {t.maxNumbers}
                    </td>
                    <td className="num">{formatNumber(t.stats.contacts)}</td>
                    <td className="num">{formatNumber(t.stats.sentThisMonth)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewBusinessModal onClose={() => setCreating(false)} onCreated={() => void reload()} />}
      {open && <BusinessDrawer tenantId={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />}
    </div>
  );
}

// ---------------------------------------------------------------- payments

export function AdminPaymentsPage() {
  const { me } = useSession();
  const symbol = me.brand.currencySymbol;
  const { data, error, loading } = useApi<Payment[]>('/api/admin/payments');
  const total = (data ?? []).reduce((sum, p) => sum + p.amount, 0);
  return (
    <div className="page">
      <PageHeader title="Payments" description={data ? `${data.length} payments · ${money(symbol, total)} in total` : undefined} />
      <ErrorNote error={error} />
      <Card bodyClass="">
        {loading && !data ? (
          <Loading />
        ) : data?.length === 0 ? (
          <Empty title="No payments yet">Record a payment from a business's page when they pay you.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Business</th>
                  <th>Method</th>
                  <th>Period</th>
                  <th>Recorded by</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data?.map(p => (
                  <tr key={p.id}>
                    <td className="nowrap">{formatDateTime(p.paidAt)}</td>
                    <td>{p.tenantName}</td>
                    <td>
                      {METHODS[p.method] ?? p.method}
                      {p.reference && <div className="small secondary">{p.reference}</div>}
                    </td>
                    <td className="small secondary">
                      {formatDate(p.periodStart)} – {formatDate(p.periodEnd)}
                    </td>
                    <td className="small secondary">{p.recordedBy ?? '–'}</td>
                    <td className="num">{money(symbol, p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- settings

export function AdminSettingsPage() {
  const { reload: reloadSession } = useSession();
  const { data, loading } = useApi<PlatformSettings>('/api/admin/settings');
  const [form, setForm] = useState<PlatformSettings | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const toast = useToast();
  const value = form ?? data;
  if (loading && !data) return <Loading />;
  if (!value) return null;
  const set = (patchValue: Partial<PlatformSettings>) => setForm({ ...value, ...patchValue });
  return (
    <div className="page">
      <PageHeader
        title="Admin settings"
        description="Your brand and the defaults for new businesses."
        actions={
          <Button
            variant="primary"
            onClick={async () => {
              try {
                setForm(await put<PlatformSettings>('/api/admin/settings', value));
                await reloadSession();
                toast.success('Saved');
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            Save
          </Button>
        }
      />
      <Card title="Your brand" subtitle="Shown on the login page and in every business's dashboard.">
        <div className="grid cols-2">
          <Field label="Product name">
            <input className="input" value={value.brandName} onChange={e => set({ brandName: e.target.value })} />
          </Field>
          <Field label="Support contact" hint="Shown to businesses in renewal reminders, e.g. 'WhatsApp +91 98450 00000'.">
            <input className="input" value={value.supportContact} onChange={e => set({ supportContact: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card title="New business defaults">
        <div className="grid cols-3">
          <Field label="Currency symbol">
            <input className="input" value={value.currencySymbol} onChange={e => set({ currencySymbol: e.target.value })} />
          </Field>
          <Field label="Monthly price">
            <input className="input" type="number" value={value.defaultPrice} onChange={e => set({ defaultPrice: Number(e.target.value) })} />
          </Field>
          <Field label="WhatsApp numbers allowed">
            <input className="input" type="number" min={1} value={value.defaultMaxNumbers} onChange={e => set({ defaultMaxNumbers: Number(e.target.value) })} />
          </Field>
          <Field label="Free trial (days)">
            <input className="input" type="number" min={0} value={value.trialDays} onChange={e => set({ trialDays: Number(e.target.value) })} />
          </Field>
          <Field label="Grace period (days)" hint="Days after the renewal date that sending keeps working.">
            <input className="input" type="number" min={0} value={value.graceDays} onChange={e => set({ graceDays: Number(e.target.value) })} />
          </Field>
          <Field label="Messages per day, per number" hint="Starting daily limit. Raise it per business later.">
            <input className="input" type="number" min={1} value={value.defaultDailyCap} onChange={e => set({ defaultDailyCap: Number(e.target.value) })} />
          </Field>
          <Field label="Max messages per minute, per number">
            <input className="input" type="number" min={1} max={60} value={value.defaultPerMinuteCap} onChange={e => set({ defaultPerMinuteCap: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>
      <Card title="Your password">
        <form
          className="grid cols-3"
          onSubmit={async e => {
            e.preventDefault();
            try {
              await post('/api/admin/password', pw);
              toast.success('Password changed. Sign in again with the new one.');
              setPw({ current: '', next: '' });
              await reloadSession();
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} />
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <Button type="submit" disabled={!pw.current || pw.next.length < 8}>
              Change password
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
