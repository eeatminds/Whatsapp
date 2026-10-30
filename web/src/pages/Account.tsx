import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, patch, post, useApi, errorMessage, ROLE_LABEL, type Payment, type PlatformUser, type TenantInfo } from '../api';
import { Button, Callout, Card, ErrorNote, Field, Loading, Modal, PageHeader, useConfirm, useToast } from '../components/ui';
import { IconCopy } from '../components/icons';
import { useSession, money } from '../session';
import { formatDate, relativeTime } from '../format';
import { AccessBadge } from './Admin';

const METHODS: Record<string, string> = { upi: 'UPI', cash: 'Cash', bank_transfer: 'Bank transfer', card: 'Card', other: 'Other' };

type Secret = { title: string; lines: Array<[string, string]> };

/** Set a team member's password: one the admin types, or one made up when left empty. */
function PasswordDialog({ user, onClose, onDone }: { user: PlatformUser; onClose: () => void; onDone: (password: string) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ password: string }>(`/api/account/users/${user.id}/password`, { password: value });
      onDone(r.password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`New password for ${user.name || user.email}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={value.length > 0 && value.length < 8} onClick={() => void save()}>
            {value ? 'Set password' : 'Make one up'}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={e => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="New password" hint="At least 8 characters. Leave empty and WA Reach makes up an easy-to-type one.">
          <input className="input" type="text" autoComplete="new-password" autoFocus value={value} onChange={e => setValue(e.target.value)} />
        </Field>
        <p className="small muted" style={{ margin: 0 }}>
          They are signed out everywhere and sign in again with the new password.
        </p>
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}

/** People who can sign in: the admin (everything), team members (everything but billing and team) and callers (Leads only). */
function TeamCard({
  users,
  isOwner,
  myId,
  onChanged,
  onSecret,
}: {
  users: PlatformUser[];
  isOwner: boolean;
  myId: number | null;
  onChanged: () => void;
  onSecret: (s: Secret) => void;
}) {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [form, setForm] = useState({ email: '', name: '', role: 'caller' as 'caller' | 'member' });
  const [passwordFor, setPasswordFor] = useState<PlatformUser | null>(null);
  const change = async (u: PlatformUser, body: Partial<Pick<PlatformUser, 'role' | 'leadScope'>>) => {
    try {
      await patch(`/api/account/users/${u.id}`, body);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Card title="Team" subtitle="Admin: everything. Team member: everything except billing and team. Caller: only their Leads page.">
      <div className="stack">
        <div>
          {users.map(u => (
            <div key={u.id} className="team-row">
              <div className="stack tight" style={{ minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <strong style={{ overflowWrap: 'anywhere' }}>{u.name || u.email}</strong>
                  <span className={`role-badge ${u.role}`}>{ROLE_LABEL[u.role]}</span>
                  {u.id === myId && <span className="small muted">(you)</span>}
                </div>
                <span className="small secondary">
                  {u.name ? `${u.email} · ` : ''}
                  {u.lastLoginAt ? `last seen ${relativeTime(u.lastLoginAt)}` : 'never signed in'}
                  {u.role === 'caller' && (
                    <>
                      {' · '}
                      <Link to={`/leads?assignee=${u.id}`}>their leads</Link>
                    </>
                  )}
                </span>
                {isOwner && u.role !== 'owner' && (
                  <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                    <select className="select sm" style={{ width: 'auto' }} value={u.role} aria-label={`Role of ${u.email}`} onChange={e => void change(u, { role: e.target.value as 'caller' | 'member' })}>
                      <option value="caller">Caller: Leads only</option>
                      <option value="member">Team member: full access</option>
                    </select>
                    {u.role === 'caller' && (
                      <select
                        className="select sm"
                        style={{ width: 'auto' }}
                        value={u.leadScope}
                        aria-label={`Which leads ${u.email} sees`}
                        onChange={e => void change(u, { leadScope: e.target.value as 'assigned' | 'all' })}
                      >
                        <option value="assigned">Sees only leads given to them</option>
                        <option value="all">Sees all leads</option>
                      </select>
                    )}
                  </div>
                )}
              </div>
              {isOwner && u.role !== 'owner' && (
                <div className="row" style={{ gap: 4 }}>
                  <Button size="sm" onClick={() => setPasswordFor(u)}>
                    Set password
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const extra = u.role === 'caller' ? ' Leads given to them go back to “Not given yet”.' : '';
                      if (!(await confirm(`Remove ${u.email}?`, `They will no longer be able to sign in.${extra}`, { confirmLabel: 'Remove', danger: true }))) return;
                      try {
                        await del(`/api/account/users/${u.id}`);
                        onChanged();
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
        {isOwner && (
          <form
            className="stack tight"
            onSubmit={async e => {
              e.preventDefault();
              try {
                const r = await post<{ user: PlatformUser; password: string }>('/api/account/users', {
                  email: form.email,
                  name: form.name.trim() || undefined,
                  role: form.role,
                });
                onSecret({
                  title: form.role === 'caller' ? 'Caller added' : 'Team member added',
                  lines: [
                    ['Email', r.user.email],
                    ['Password', r.password],
                    ['Login page', window.location.origin],
                  ],
                });
                setForm({ email: '', name: '', role: form.role });
                onChanged();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            <span className="label">Add someone</span>
            <div className="row wrap" style={{ gap: 6 }}>
              <input className="input sm" style={{ flex: '2 1 180px' }} type="email" placeholder="colleague@business.com" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} aria-label="Email" />
              <input className="input sm" style={{ flex: '1 1 120px' }} placeholder="Name (optional)" maxLength={80} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} aria-label="Name" />
              <select className="select sm" style={{ width: 'auto' }} value={form.role} onChange={e => setForm({ ...form, role: e.target.value as 'caller' | 'member' })} aria-label="Role">
                <option value="caller">Caller</option>
                <option value="member">Team member</option>
              </select>
              <Button size="sm" type="submit" disabled={!form.email}>
                Add
              </Button>
            </div>
            <span className="hint">
              {form.role === 'caller'
                ? 'Callers only see the Leads page, with the leads you give them. Only you can change their password.'
                : 'Team members can use everything except Account & billing.'}
            </span>
          </form>
        )}
      </div>
      {passwordFor && (
        <PasswordDialog
          user={passwordFor}
          onClose={() => setPasswordFor(null)}
          onDone={password => {
            const user = passwordFor;
            setPasswordFor(null);
            onSecret({ title: 'Password changed', lines: [['Email', user.email], ['New password', password], ['Login page', window.location.origin]] });
            onChanged();
          }}
        />
      )}
      {dialog}
    </Card>
  );
}

export function AccountPage() {
  const { me, reload: reloadSession } = useSession();
  const { data, error, loading, reload } = useApi<{ tenant: TenantInfo; users: PlatformUser[]; payments: Payment[]; support: string; currencySymbol: string }>('/api/account/');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [secret, setSecret] = useState<Secret | null>(null);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const isOwner = me.user?.role === 'owner' || me.user?.role === 'platform_admin';

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const { tenant } = data;
  const symbol = data.currencySymbol;

  return (
    <div className="page">
      <PageHeader title="Account & billing" description={tenant.name} />
      <Card title="Subscription">
        <div className="stack">
          <div className="row wrap">
            <AccessBadge tenant={tenant} />
            <span>
              {money(symbol, tenant.priceMonthly)} per month · up to {tenant.maxNumbers} WhatsApp number{tenant.maxNumbers > 1 ? 's' : ''}
            </span>
          </div>
          <dl className="kv">
            <dt>Paid until</dt>
            <dd>
              {formatDate(tenant.paidUntil)}{' '}
              <span className="muted">({tenant.daysLeft >= 0 ? `${tenant.daysLeft} days left` : `ended ${-tenant.daysLeft} days ago`})</span>
            </dd>
            <dt>To renew</dt>
            <dd>{data.support ? `Pay and contact ${data.support}` : 'Contact your provider'}</dd>
          </dl>
          {data.payments.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Paid on</th>
                  <th>Covers</th>
                  <th>Method</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map(p => (
                  <tr key={p.id}>
                    <td>{formatDate(p.paidAt)}</td>
                    <td className="small secondary">
                      {formatDate(p.periodStart)} – {formatDate(p.periodEnd)}
                    </td>
                    <td className="small">{METHODS[p.method] ?? p.method}</td>
                    <td className="num">{money(symbol, p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <div className="grid cols-2">
        <TeamCard users={data.users} isOwner={isOwner} myId={me.user?.id ?? null} onChanged={() => void reload()} onSecret={setSecret} />

        <Card title="Your password">
          {me.impersonating ? (
            <p className="secondary">You're viewing this account as the admin. Reset the owner's password from the admin panel.</p>
          ) : (
            <form
              className="stack"
              onSubmit={async e => {
                e.preventDefault();
                try {
                  await post('/api/account/password', pw);
                  toast.success('Password changed. Sign in with your new password.');
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
              <div>
                <Button type="submit" disabled={!pw.current || pw.next.length < 8}>
                  Change password
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>

      {isOwner && (
        <Card title="API access" subtitle="Add contacts from your website forms, CRM, Zapier or n8n.">
          <div className="stack">
            <p className="secondary">
              {tenant.apiKeyPrefix ? (
                <>
                  Active key: <code>{tenant.apiKeyPrefix}…</code>
                </>
              ) : (
                'No API key yet.'
              )}
            </p>
            <div className="row wrap">
              <Button
                onClick={async () => {
                  if (tenant.apiKeyPrefix && !(await confirm('Create a new API key?', 'The current key stops working immediately.'))) return;
                  const r = await post<{ key: string }>('/api/account/api-key');
                  setSecret({ title: 'Your API key', lines: [['X-API-Key', r.key]] });
                  void reload();
                }}
              >
                {tenant.apiKeyPrefix ? 'Create a new key' : 'Create API key'}
              </Button>
              {tenant.apiKeyPrefix && (
                <Button
                  variant="danger"
                  onClick={async () => {
                    await del('/api/account/api-key');
                    void reload();
                  }}
                >
                  Revoke
                </Button>
              )}
            </div>
            <pre className="mono" style={{ margin: 0, padding: 12, background: 'var(--surface-sunken)', borderRadius: 8, overflowX: 'auto' }}>
              {`curl -X POST ${window.location.origin}/api/contacts \\
  -H "X-API-Key: <your key>" -H "Content-Type: application/json" \\
  -d '{"phone":"+919876543210","name":"Priya","tags":["website-lead"],
       "consent":"opted_in","consentSource":"website form"}'`}
            </pre>
            <p className="hint">Use the key only from your server, never inside a public web page.</p>
          </div>
        </Card>
      )}

      {secret && (
        <Modal title={secret.title} onClose={() => setSecret(null)} footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}>
          <Callout tone="warn">Copy this now. It won't be shown again.</Callout>
          <dl className="kv">
            {secret.lines.map(([label, value]) => (
              <div key={label} style={{ display: 'contents' }}>
                <dt>{label}</dt>
                <dd className="row" style={{ gap: 6 }}>
                  <code style={{ overflowWrap: 'anywhere' }}>{value}</code>
                  <Button size="sm" variant="ghost" icon={<IconCopy size={14} />} aria-label="Copy" onClick={() => void navigator.clipboard?.writeText(value)} />
                </dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}
      {dialog}
    </div>
  );
}
