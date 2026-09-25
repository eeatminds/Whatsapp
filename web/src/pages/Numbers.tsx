import { useEffect, useState } from 'react';
import { del, get, post, put, errorMessage, type Session, type Settings } from '../api';
import { Badge, Button, Callout, Card, Empty, ErrorNote, Field, Loading, Modal, PageHeader, Segmented, useConfirm, useToast } from '../components/ui';
import { IconPlus, IconRefresh } from '../components/icons';
import { useSessions } from '../components/pickers';
import { formatNumber, relativeTime } from '../format';

const STATUS: Record<Session['status'], { label: string; tone?: 'green' | 'blue' | 'amber' | 'red' }> = {
  ready: { label: 'Connected', tone: 'green' },
  qr_ready: { label: 'Waiting for QR scan', tone: 'blue' },
  authenticating: { label: 'Linking…', tone: 'blue' },
  initializing: { label: 'Starting…', tone: 'blue' },
  created: { label: 'Not started' },
  disconnected: { label: 'Disconnected', tone: 'amber' },
  action_required: { label: 'Needs attention', tone: 'amber' },
  failed: { label: 'Failed', tone: 'red' },
};

function LinkModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const [mode, setMode] = useState<'qr' | 'code'>('qr');
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<Session['status']>(session.status);
  const [lastError, setLastError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const sessions = await get<{ items: Session[] }>('/api/sessions');
        const current = sessions.items.find(s => s.id === session.id);
        if (current) {
          setStatus(current.status);
          setLastError(current.lastError ?? null);
        }
        if (current?.status === 'ready') return;
        if (mode === 'qr' && current?.status === 'qr_ready') {
          const result = await get<{ qrCode: string }>(`/api/sessions/${session.id}/qr`);
          if (!stopped) setQr(result.qrCode);
        }
      } catch {
        // Keep polling: the engine may still be starting.
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session.id, mode]);

  return (
    <Modal title={`Link ${session.name}`} onClose={onClose} footer={<Button onClick={onClose}>{status === 'ready' ? 'Done' : 'Close'}</Button>}>
      {status === 'ready' ? (
        <Callout tone="success">Connected. This number can now send campaigns.</Callout>
      ) : status === 'failed' || status === 'action_required' ? (
        <div className="stack">
          <Callout tone="danger">
            The gateway could not start this number{lastError ? `: ${lastError}` : '.'} Check that the OpenWA server can reach web.whatsapp.com.
          </Callout>
          <div>
            <Button
              variant="primary"
              loading={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await post(`/api/sessions/${session.id}/start`);
                  setStatus('initializing');
                } catch (err) {
                  setLastError(errorMessage(err));
                } finally {
                  setRetrying(false);
                }
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'qr', label: 'Scan QR code' },
              { value: 'code', label: 'Use phone number' },
            ]}
          />
          {mode === 'qr' ? (
            <div className="stack">
              <ol className="secondary" style={{ margin: 0, paddingLeft: 18 }}>
                <li>Open WhatsApp on the phone for this number.</li>
                <li>
                  Go to <strong>Settings → Linked devices → Link a device</strong>.
                </li>
                <li>Point the camera at this code.</li>
              </ol>
              <div className="qr-box">{qr ? <img src={qr} alt="WhatsApp linking QR code" /> : <Loading />}</div>
              <p className="hint">Status: {STATUS[status]?.label ?? status}. The code refreshes automatically.</p>
            </div>
          ) : (
            <div className="stack">
              <Field label="Phone number of the WhatsApp account" hint="Full international number, e.g. 919876543210.">
                <input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="919876543210" />
              </Field>
              <ErrorNote error={error} />
              {code ? (
                <Callout tone="success">
                  In WhatsApp choose <strong>Link with phone number instead</strong> and enter <strong className="mono" style={{ fontSize: 16 }}>{code}</strong>
                </Callout>
              ) : (
                <div>
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={phone.replace(/\D/g, '').length < 8}
                    onClick={async () => {
                      setBusy(true);
                      setError(null);
                      try {
                        const result = await post<{ pairingCode: string }>(`/api/sessions/${session.id}/pairing-code`, { phone });
                        setCode(result.pairingCode);
                      } catch (err) {
                        setError(errorMessage(err));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Get pairing code
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function NumbersPage() {
  const { data, error, loading, reload } = useSessions({ poll: 8000 });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [linking, setLinking] = useState<Session | null>(null);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const act = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(`${id}:${label}`);
    try {
      await fn();
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const sessions = data?.items ?? [];

  return (
    <div className="page">
      <PageHeader
        title="WhatsApp numbers"
        description="Numbers linked through your OpenWA gateway. Campaigns and replies are sent from these."
        actions={
          <>
            <Button icon={<IconRefresh size={16} />} onClick={() => void reload()}>
              Refresh
            </Button>
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setAdding(true)}>
              Add number
            </Button>
          </>
        }
      />
      <ErrorNote error={error} />
      {data && !data.gateway.reachable && <Callout tone="danger">The OpenWA gateway is unreachable. Check OPENWA_URL and that the gateway container is running.</Callout>}
      <Callout tone="warn">
        OpenWA links numbers the way WhatsApp Web does, not through Meta's official Cloud API, so a number can be restricted if WhatsApp sees spam.
        Use a dedicated number, warm it up for a few days before bulk sending, and message only people who expect to hear from you.
      </Callout>

      {loading && !data ? (
        <Loading />
      ) : sessions.length === 0 ? (
        <Card>
          <Empty title="No numbers yet" action={<Button variant="primary" onClick={() => setAdding(true)}>Add your first number</Button>}>
            Add a number, then scan the QR code with WhatsApp on that phone.
          </Empty>
        </Card>
      ) : (
        <div className="grid cols-2">
          {sessions.map(s => {
            const status = STATUS[s.status] ?? { label: s.status };
            const isDefault = data?.defaultSessionId === s.id;
            const used = s.marketingSentToday ?? 0;
            const cap = data?.dailyCap ?? 0;
            return (
              <Card
                key={s.id}
                title={
                  <span className="row">
                    {s.name}
                    {isDefault && <Badge tone="blue">Default</Badge>}
                  </span>
                }
                subtitle={s.phone ? `+${s.phone}${s.pushName ? ` · ${s.pushName}` : ''}` : 'Not linked yet'}
                actions={<Badge tone={status.tone} dot>{status.label}</Badge>}
                footer={
                  <div className="row wrap">
                    {s.status !== 'ready' && (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy === `${s.id}:link`}
                        onClick={() =>
                          act(s.id, 'link', async () => {
                            if (!['qr_ready', 'initializing', 'authenticating'].includes(s.status)) await post(`/api/sessions/${s.id}/start`);
                            setLinking(s);
                          })
                        }
                      >
                        Link device
                      </Button>
                    )}
                    {!isDefault && (
                      <Button size="sm" onClick={() => act(s.id, 'default', () => put<Settings>('/api/settings', { defaultSessionId: s.id }))}>
                        Make default
                      </Button>
                    )}
                    {s.status === 'ready' && (
                      <Button size="sm" loading={busy === `${s.id}:stop`} onClick={() => act(s.id, 'stop', () => post(`/api/sessions/${s.id}/stop`))}>
                        Stop
                      </Button>
                    )}
                    {s.status === 'disconnected' && (
                      <Button size="sm" loading={busy === `${s.id}:start`} onClick={() => act(s.id, 'start', () => post(`/api/sessions/${s.id}/start`))}>
                        Start
                      </Button>
                    )}
                    <span className="spacer" />
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        const ok = await confirm('Remove this number?', 'The device is unlinked in OpenWA. Campaigns using it will wait until you choose another number.', {
                          confirmLabel: 'Remove',
                          danger: true,
                        });
                        if (ok) await act(s.id, 'delete', () => del(`/api/sessions/${s.id}`));
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                }
              >
                <div className="stack tight">
                  <div className="row between small">
                    <span className="secondary">Marketing messages today</span>
                    <span className="num">
                      {formatNumber(used)} / {formatNumber(cap)}
                    </span>
                  </div>
                  <div className="progress" aria-hidden="true">
                    <div style={{ width: `${cap ? Math.min(100, (used / cap) * 100) : 0}%` }} />
                  </div>
                  {s.hold && <Callout tone="warn">Paused until {new Date(s.hold.until).toLocaleTimeString()}: {s.hold.reason}</Callout>}
                  {s.restriction?.active && <Callout tone="danger">WhatsApp has restricted this account ({s.restriction.kind ?? 'unknown'}). Stop bulk sending until it lifts.</Callout>}
                  {s.lastError && s.status !== 'ready' && <p className="small error-text">{s.lastError}</p>}
                  {s.connectedAt && s.status === 'ready' && <p className="small muted">Connected {relativeTime(s.connectedAt)}</p>}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {adding && (
        <Modal
          title="Add a WhatsApp number"
          onClose={() => setAdding(false)}
          footer={
            <>
              <Button onClick={() => setAdding(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={busy === 'new:create'}
                disabled={!/^[A-Za-z0-9-]{3,50}$/.test(name)}
                onClick={() =>
                  act('new', 'create', async () => {
                    const session = await post<Session>('/api/sessions', { name });
                    setAdding(false);
                    setName('');
                    setLinking(session);
                  })
                }
              >
                Create and link
              </Button>
            </>
          }
        >
          <Field label="Name" hint="Letters, digits and hyphens, e.g. sales-line or store-bengaluru.">
            <input className="input" value={name} onChange={e => setName(e.target.value.replace(/\s+/g, '-'))} placeholder="sales-line" />
          </Field>
        </Modal>
      )}
      {linking && (
        <LinkModal
          session={linking}
          onClose={() => {
            setLinking(null);
            void reload();
          }}
        />
      )}
      {dialog}
    </div>
  );
}
