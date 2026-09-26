import { useEffect, useState } from 'react';
import { del, get, post, put, useApi, errorMessage, type Session, type Settings, type SystemInfo } from '../api';
import { Badge, Button, Callout, Card, Empty, ErrorNote, Field, Loading, Modal, PageHeader, Segmented, useConfirm, useToast } from '../components/ui';
import { IconPlus, IconRefresh } from '../components/icons';
import { useSessions } from '../components/pickers';
import { formatNumber, relativeTime } from '../format';
import { OfficialConnectModal, OfficialTemplatesModal } from '../components/official';

const QUALITY: Record<string, { label: string; tone: 'green' | 'amber' | 'red' }> = {
  GREEN: { label: 'High', tone: 'green' },
  YELLOW: { label: 'Medium', tone: 'amber' },
  RED: { label: 'Low', tone: 'red' },
};

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
            The gateway could not start this number{lastError ? `: ${lastError}` : '.'} Try again in a minute. If it keeps failing, contact support.
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
  const { data: system } = useApi<SystemInfo>('/api/system');
  const [adding, setAdding] = useState(false);
  const [addKind, setAddKind] = useState<'qr' | 'official'>('qr');
  const [connecting, setConnecting] = useState<{ existing: Session | null } | null>(null);
  const [templatesFor, setTemplatesFor] = useState<Session | null>(null);
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
  const hasQr = sessions.some(s => s.channel !== 'official');

  return (
    <div className="page">
      <PageHeader
        title="WhatsApp numbers"
        description="Your linked WhatsApp numbers. Campaigns and replies are sent from these."
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
      {system?.demo && (
        <Callout tone="warn">
          <strong>Demo mode:</strong> numbers here are simulated, so the QR code can't be scanned and no real WhatsApp messages are sent. To connect a real phone, run WA Reach with the OpenWA gateway using Docker (see the README, “Run for real”).
        </Callout>
      )}
      <ErrorNote error={error} />
      {data && !data.gateway.reachable && (hasQr || sessions.length === 0) && <Callout tone="danger">The WhatsApp gateway is unreachable right now, so numbers can't connect or send. Try again in a few minutes.</Callout>}
      {hasQr && (
        <Callout tone="warn">
          QR-linked numbers work the way WhatsApp Web does, not through Meta's official Cloud API, so a number can be restricted if WhatsApp sees spam. Use a dedicated number, warm it up for a few days before
          bulk sending, and message only people who expect to hear from you. For the safest high-volume sending, connect an <strong>official WhatsApp Business API</strong> number instead.
        </Callout>
      )}

      {loading && !data ? (
        <Loading />
      ) : sessions.length === 0 ? (
        <Card>
          <Empty title="No numbers yet" action={<Button variant="primary" onClick={() => setAdding(true)}>Add your first number</Button>}>
            Link a phone by scanning a QR code, or connect an official WhatsApp Business API number from your own Meta account.
          </Empty>
        </Card>
      ) : (
        <div className="grid cols-2">
          {sessions.map(s => {
            if (s.channel === 'official') {
              const isDefault = data?.defaultSessionId === s.id;
              const used = s.marketingSentToday ?? 0;
              const cap = data?.dailyCap ?? 0;
              const quality = s.official?.qualityRating ? QUALITY[s.official.qualityRating.toUpperCase()] : undefined;
              return (
                <Card
                  key={s.id}
                  title={
                    <span className="row">
                      {s.name}
                      <Badge tone="green">Official API</Badge>
                      {isDefault && <Badge tone="blue">Default</Badge>}
                    </span>
                  }
                  subtitle={`${s.phone ? `+${s.phone}` : 'Number pending'}${s.pushName ? ` · ${s.pushName}` : ''}`}
                  actions={
                    <Badge tone={s.status === 'ready' ? 'green' : 'red'} dot>
                      {s.status === 'ready' ? 'Connected' : 'Needs attention'}
                    </Badge>
                  }
                  footer={
                    <div className="row wrap">
                      <Button size="sm" onClick={() => setTemplatesFor(s)}>
                        Templates
                      </Button>
                      <Button size="sm" loading={busy === `${s.id}:check`} onClick={() => act(s.id, 'check', () => post(`/api/official/numbers/${s.id}/check`))}>
                        Check connection
                      </Button>
                      <Button size="sm" onClick={() => setConnecting({ existing: s })}>
                        Update token
                      </Button>
                      {!isDefault && (
                        <Button size="sm" onClick={() => act(s.id, 'default', () => put<Settings>('/api/settings', { defaultSessionId: s.id }))}>
                          Make default
                        </Button>
                      )}
                      <span className="spacer" />
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          const ok = await confirm('Disconnect this official number?', 'Its saved Meta token is deleted here. Your number and templates stay in your Meta account.', {
                            confirmLabel: 'Disconnect',
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
                    <dl className="kv small">
                      <dt>Approved templates</dt>
                      <dd>
                        {s.templates?.approved ?? 0}
                        {s.templates && s.templates.total > s.templates.approved ? ` (${s.templates.total - s.templates.approved} waiting or rejected)` : ''}
                      </dd>
                      <dt>Quality (Meta)</dt>
                      <dd>{quality ? <Badge tone={quality.tone}>{quality.label}</Badge> : 'Not rated yet'}</dd>
                      <dt>Replies &amp; receipts</dt>
                      <dd>{s.official?.webhookSeenAt ? `Receiving (last ${relativeTime(s.official.webhookSeenAt)})` : 'Nothing received yet: check the webhook (step 5)'}</dd>
                    </dl>
                    {s.hold && <Callout tone="warn">Paused until {new Date(s.hold.until).toLocaleTimeString()}: {s.hold.reason}</Callout>}
                    {s.lastError && <p className="small error-text">{s.lastError}</p>}
                  </div>
                </Card>
              );
            }
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
                        const ok = await confirm('Remove this number?', 'The device is unlinked. Campaigns using it will wait until you choose another number.', {
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
                disabled={addKind === 'qr' && !/^[A-Za-z0-9-]{3,50}$/.test(name)}
                onClick={() =>
                  addKind === 'official'
                    ? (setAdding(false), setConnecting({ existing: null }))
                    : act('new', 'create', async () => {
                    const session = await post<Session>('/api/sessions', { name });
                    setAdding(false);
                    setName('');
                    setLinking(session);
                  })
                }
              >
                {addKind === 'official' ? 'Continue' : 'Create and link'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <label className={`option-card ${addKind === 'qr' ? 'selected' : ''}`}>
              <input type="radio" name="add-kind" checked={addKind === 'qr'} onChange={() => setAddKind('qr')} />
              <span>
                <strong>Scan a QR code</strong>
                <br />
                <span className="small secondary">Quickest: link a WhatsApp phone in a minute, like WhatsApp Web. Send any message, no templates. Unofficial, so keep volumes modest.</span>
              </span>
            </label>
            <label className={`option-card ${addKind === 'official' ? 'selected' : ''}`}>
              <input type="radio" name="add-kind" checked={addKind === 'official'} onChange={() => setAddKind('official')} />
              <span>
                <strong>Official WhatsApp Business API (Meta)</strong>
                <br />
                <span className="small secondary">
                  Connect your own Meta app. No ban risk from an unofficial link, Meta-approved templates, delivery reports from Meta. Meta bills you per template message. Step-by-step guide included.
                </span>
              </span>
            </label>
            {addKind === 'qr' && (
              <Field label="Name" hint="Letters, digits and hyphens, e.g. sales-line or store-bengaluru.">
                <input className="input" value={name} onChange={e => setName(e.target.value.replace(/\s+/g, '-'))} placeholder="sales-line" />
              </Field>
            )}
          </div>
        </Modal>
      )}
      {connecting && (
        <OfficialConnectModal
          existing={connecting.existing}
          onClose={() => setConnecting(null)}
          onDone={session => {
            setConnecting(null);
            toast.success(connecting.existing ? 'Saved' : `${session.name} connected`);
            void reload();
          }}
        />
      )}
      {templatesFor && <OfficialTemplatesModal session={templatesFor} onClose={() => { setTemplatesFor(null); void reload(); }} />}
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
