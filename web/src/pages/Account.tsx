import { useState } from 'react';
import { del, post, useApi, errorMessage, type Payment, type PlatformUser, type TenantInfo } from '../api';
import { Button, Callout, Card, ErrorNote, Field, Loading, Modal, PageHeader, useConfirm, useToast } from '../components/ui';
import { IconCopy } from '../components/icons';
import { useSession, money } from '../session';
import { formatDate, relativeTime } from '../format';
import { AccessBadge } from './Admin';

const METHODS: Record<string, string> = { upi: 'UPI', cash: 'Cash', bank_transfer: 'Bank transfer', card: 'Card', other: 'Other' };

export function AccountPage() {
  const { me, reload: reloadSession } = useSession();
  const { data, error, loading, reload } = useApi<{ tenant: TenantInfo; users: PlatformUser[]; payments: Payment[]; support: string; currencySymbol: string }>('/api/account/');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [member, setMember] = useState('');
  const [secret, setSecret] = useState<{ title: string; lines: Array<[string, string]> } | null>(null);
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
        <Card title="Team" subtitle="People who can sign in to this account.">
          <div className="stack">
            {data.users.map(u => (
              <div key={u.id} className="row between">
                <div>
                  <strong>{u.email}</strong>
                  <div className="small secondary">
                    {u.role === 'owner' ? 'Owner' : 'Team member'} · {u.lastLoginAt ? `last seen ${relativeTime(u.lastLoginAt)}` : 'never signed in'}
                  </div>
                </div>
                {isOwner && u.role === 'member' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (!(await confirm(`Remove ${u.email}?`, 'They will no longer be able to sign in.', { confirmLabel: 'Remove', danger: true }))) return;
                      await del(`/api/account/users/${u.id}`);
                      void reload();
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
            {isOwner && (
              <form
                className="row"
                onSubmit={async e => {
                  e.preventDefault();
                  try {
                    const r = await post<{ user: PlatformUser; password: string }>('/api/account/users', { email: member });
                    setSecret({ title: 'Team member added', lines: [['Email', r.user.email], ['Temporary password', r.password], ['Login page', window.location.origin]] });
                    setMember('');
                    void reload();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <input className="input sm" type="email" placeholder="colleague@business.com" value={member} onChange={e => setMember(e.target.value)} />
                <Button size="sm" type="submit" disabled={!member}>
                  Add
                </Button>
              </form>
            )}
          </div>
        </Card>

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
