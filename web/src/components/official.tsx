import { useEffect, useState, type ReactNode } from 'react';
import { get, patch, post, useApi, errorMessage, type MetaTemplate, type OfficialSetup, type Session, type TemplateChoice } from '../api';
import { Badge, Button, Callout, ErrorNote, Field, Loading, Modal } from './ui';
import { IconCopy } from './icons';
import { AttachedMedia, MediaPicker } from './media';
import { WhatsAppText } from './composer';
import { relativeTime } from '../format';

const META_APPS = 'https://developers.facebook.com/apps';
const BUSINESS_SETTINGS = 'https://business.facebook.com/latest/settings';
const TEMPLATE_MANAGER = 'https://business.facebook.com/latest/whatsapp_manager/message_templates';
const META_GUIDE = 'https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started';
const YOUTUBE_SEARCH = 'https://www.youtube.com/results?search_query=WhatsApp+Cloud+API+setup+permanent+access+token+webhook';

/** The video id from a YouTube watch, share, shorts or embed link, for a privacy-friendly embed. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.slice(1);
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] ?? null;
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function CopyField({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="row" style={{ gap: 6 }}>
        <input className="input mono" readOnly value={value} onFocus={e => e.target.select()} aria-label={label} />
        <Button
          size="sm"
          icon={<IconCopy size={14} />}
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------- setup guide

function GuideStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="guide-step">
      <span className="n">{n}</span>
      <div className="stack tight">
        <strong>{title}</strong>
        <div className="small secondary stack tight">{children}</div>
      </div>
    </li>
  );
}

/** Step-by-step instructions for getting the four values from Meta, with the admin's video if set. */
export function OfficialGuide({ setup }: { setup: OfficialSetup | undefined }) {
  const video = youtubeId(setup?.guideVideoUrl);
  return (
    <div className="stack">
      {video ? (
        <div className="video-frame">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${video}`}
            title="How to set up the WhatsApp Cloud API"
            allow="encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            loading="lazy"
          />
        </div>
      ) : setup?.guideVideoUrl ? (
        <Callout>
          <Ext href={setup.guideVideoUrl}>▶ Watch the setup video</Ext>
        </Callout>
      ) : (
        <Callout>
          Prefer video? <Ext href={YOUTUBE_SEARCH}>▶ Watch a WhatsApp Cloud API setup walkthrough on YouTube</Ext>. Meta's own guide:{' '}
          <Ext href={META_GUIDE}>Get started with the Cloud API</Ext>.
        </Callout>
      )}
      <div className="small secondary">
        <strong>You need:</strong> a Facebook account, a Meta Business portfolio, and a phone number that can receive an SMS or call and is <em>not</em> in use on the WhatsApp or WhatsApp Business app (delete WhatsApp from it first). Takes about 20 minutes.
      </div>
      <ol className="guide">
        <GuideStep n={1} title="Create a Meta app">
          <span>
            Open <Ext href={META_APPS}>developers.facebook.com/apps</Ext> → <strong>Create app</strong> → choose the use case{' '}
            <strong>Connect with customers through WhatsApp</strong> → pick your business portfolio → <strong>Create app</strong>.
          </span>
        </GuideStep>
        <GuideStep n={2} title="Add your business number">
          <span>
            In the app go to <strong>WhatsApp → API Setup</strong> → <strong>Add phone number</strong>. Enter your business display name, category and the number, then confirm the code sent by SMS or call.
          </span>
          <span>
            On the same page, select your number and copy the <strong>Phone number ID</strong> and the <strong>WhatsApp Business Account ID</strong> (Meta may call it the Messaging account ID). Paste both on the left.
          </span>
        </GuideStep>
        <GuideStep n={3} title="Create a permanent access token">
          <span>
            The token on the API Setup page expires in 24 hours, so make a permanent one: <Ext href={BUSINESS_SETTINGS}>Business settings</Ext> → <strong>Users → System users</strong> →{' '}
            <strong>Add</strong> (name it e.g. “WhatsApp sender”, role <strong>Admin</strong>).
          </span>
          <span>
            Click <strong>Assign assets</strong>: your app with <strong>Full control</strong>, and your WhatsApp account with <strong>Full control</strong>.
          </span>
          <span>
            Click <strong>Generate token</strong> → choose your app → expiry <strong>Never</strong> → tick <code>business_management</code>, <code>whatsapp_business_messaging</code> and{' '}
            <code>whatsapp_business_management</code> → <strong>Generate</strong>. Copy it right away (Meta shows it once) and paste it on the left.
          </span>
        </GuideStep>
        <GuideStep n={4} title="Copy the app secret">
          <span>
            In your app: <strong>App settings → Basic</strong> → <strong>App secret</strong> → <strong>Show</strong>. It's used to check that incoming messages really come from Meta.
          </span>
        </GuideStep>
        <GuideStep n={5} title="Connect the webhook (so replies and ticks reach you)">
          <span>
            In the app: <strong>WhatsApp → Configuration</strong> → Webhook → <strong>Edit</strong>. Paste the <strong>Callback URL</strong> and <strong>Verify token</strong> shown here, then{' '}
            <strong>Verify and save</strong>.
          </span>
          <span>
            Under <strong>Webhook fields</strong> click <strong>Manage</strong> and subscribe to <code>messages</code> and <code>message_template_status_update</code>.
          </span>
        </GuideStep>
        <GuideStep n={6} title="Add a payment method and go live">
          <span>
            Meta bills your business directly for template messages. Add a card in <strong>WhatsApp Manager → Payment settings</strong>, otherwise campaigns fail with a payment error.
          </span>
          <span>
            Switch the app to <strong>Live</strong> (toggle at the top of the app dashboard; it needs a Privacy Policy URL under App settings → Basic).
          </span>
        </GuideStep>
        <GuideStep n={7} title="Create message templates">
          <span>
            Campaigns on an official number must use templates Meta has approved. Create them in{' '}
            <Ext href={TEMPLATE_MANAGER}>WhatsApp Manager → Message templates</Ext> (category <strong>Marketing</strong>, use <code>{'{{1}}'}</code> for the customer's name). Approval
            usually takes minutes to a few hours; then click <strong>Sync templates</strong> on your number here.
          </span>
        </GuideStep>
      </ol>
      <Callout tone="warn">
        <strong>How official numbers differ:</strong> campaigns send approved templates only; inbox replies, auto-replies and drip messages can only go out within 24 hours of the customer's last message; Meta charges
        per template message and sets its own daily limit (starting around 250 customers a day, raised as your quality and business verification improve).
      </Callout>
      {setup?.supportContact && <p className="small secondary">Stuck? Contact {setup.supportContact} and we'll help you set it up.</p>}
    </div>
  );
}

function WebhookBox({ setup }: { setup: OfficialSetup | undefined }) {
  if (!setup) return <Loading />;
  if (!setup.webhookUrl) {
    return <Callout tone="danger">This server has no public address yet (PUBLIC_URL), so Meta can't deliver replies. Ask your administrator to set it.</Callout>;
  }
  return (
    <div className="stack tight">
      <CopyField label="Callback URL (for step 5)" value={setup.webhookUrl} />
      <CopyField label="Verify token (for step 5)" value={setup.verifyToken} />
      {setup.webhookVerifiedAt ? (
        <p className="small success-text">✓ Meta verified this webhook {relativeTime(setup.webhookVerifiedAt)}.</p>
      ) : (
        <p className="hint">Not verified by Meta yet. It will show here once you click “Verify and save” in your Meta app.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- connect / update

export function OfficialConnectModal({ existing, onClose, onDone }: { existing?: Session | null; onClose: () => void; onDone: (session: Session) => void }) {
  const { data: setup } = useApi<OfficialSetup>('/api/official/setup');
  const [form, setForm] = useState({ name: existing?.name ?? '', phoneNumberId: '', wabaId: '', accessToken: '', appSecret: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value.trim() === '' ? '' : key === 'name' ? e.target.value : e.target.value.trim() });
  const digits = (v: string) => /^\d{5,25}$/.test(v);
  const valid = existing
    ? form.name.trim().length >= 2 && (!form.accessToken || form.accessToken.length >= 40) && (!form.appSecret || /^[A-Za-z0-9]{16,128}$/.test(form.appSecret))
    : form.name.trim().length >= 2 && digits(form.phoneNumberId) && digits(form.wabaId) && form.accessToken.length >= 40 && /^[A-Za-z0-9]{16,128}$/.test(form.appSecret);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = existing
        ? await patch<Session>(`/api/official/numbers/${existing.id}`, {
            name: form.name,
            ...(form.accessToken ? { accessToken: form.accessToken } : {}),
            ...(form.appSecret ? { appSecret: form.appSecret } : {}),
          })
        : await post<Session>('/api/official/numbers', form);
      onDone(session);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={existing ? `Update ${existing.name}` : 'Connect an official WhatsApp Business API number'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
            {existing ? 'Save' : 'Connect number'}
          </Button>
        </>
      }
    >
      <div className="official-setup">
        <div className="stack">
          <p className="secondary small" style={{ margin: 0 }}>
            Uses Meta's official WhatsApp Cloud API with your own Meta account: no risk of a ban for an unofficial connection, your verified business name on messages, and delivery reports from Meta. Follow the guide (below on phones), then paste the values here.
          </p>
          <Field label="Name for this number" hint="Only you see this, e.g. Main line.">
            <input className="input" value={form.name} onChange={set('name')} placeholder="Main line" maxLength={40} />
          </Field>
          {!existing && (
            <>
              <Field label="Phone number ID" hint="Step 2. A long number, not your phone number.">
                <input className="input mono" inputMode="numeric" value={form.phoneNumberId} onChange={set('phoneNumberId')} placeholder="106540352242922" />
              </Field>
              <Field label="WhatsApp Business Account ID" hint="Step 2. Also called the Messaging account ID.">
                <input className="input mono" inputMode="numeric" value={form.wabaId} onChange={set('wabaId')} placeholder="102290129340398" />
              </Field>
            </>
          )}
          <Field label="Permanent access token" hint={existing ? 'Leave empty to keep the saved token.' : 'Step 3. Starts with EAA… Stored encrypted and never shown again.'}>
            <input className="input mono" type="password" autoComplete="off" value={form.accessToken} onChange={set('accessToken')} placeholder={existing ? '•••••••• (saved)' : 'EAAG…'} />
          </Field>
          <Field label="App secret" hint={existing ? 'Leave empty to keep the saved secret.' : 'Step 4. Stored encrypted.'}>
            <input className="input mono" type="password" autoComplete="off" value={form.appSecret} onChange={set('appSecret')} placeholder={existing ? '•••••••• (saved)' : '32 letters and digits'} />
          </Field>
          <div className="divider" />
          <WebhookBox setup={setup} />
          <ErrorNote error={error} />
        </div>
        <div className="official-guide">
          <h3 style={{ marginTop: 0 }}>How to get these details</h3>
          <OfficialGuide setup={setup} />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- templates

const TEMPLATE_STATUS: Record<string, 'green' | 'amber' | 'red' | undefined> = { APPROVED: 'green', PENDING: 'amber', IN_APPEAL: 'amber', PAUSED: 'amber', REJECTED: 'red', DISABLED: 'red' };

export function templatePreviewText(template: MetaTemplate, params: Record<string, string> = {}): string {
  const fill = (text: string | null, part: string) => (text ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name: string) => params[`${part}:${name}`]?.trim() || m);
  return [
    template.headerText ? `*${fill(template.headerText, 'header')}*` : '',
    fill(template.bodyText, 'body'),
    template.footerText ? `_${template.footerText}_` : '',
    template.buttons.length ? template.buttons.map(b => `[${b.text}]`).join(' ') : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function OfficialTemplatesModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const { data, error, loading, setData } = useApi<{ items: MetaTemplate[] }>(`/api/official/numbers/${session.id}/templates`);
  const [busy, setBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  return (
    <Modal
      wide
      title={`Templates for ${session.name}`}
      onClose={onClose}
      footer={
        <>
          <Ext href={TEMPLATE_MANAGER}>Create or edit templates in WhatsApp Manager ↗</Ext>
          <span className="spacer" />
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setSyncError(null);
              try {
                setData(await post<{ items: MetaTemplate[] }>(`/api/official/numbers/${session.id}/sync-templates`));
              } catch (err) {
                setSyncError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Sync from Meta
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <ErrorNote error={error ?? syncError} />
      {loading && !data ? (
        <Loading />
      ) : !data?.items.length ? (
        <Callout>No templates yet. Create one in WhatsApp Manager (category Marketing), wait for approval, then click “Sync from Meta”.</Callout>
      ) : (
        <div className="stack">
          {data.items.map(t => (
            <div key={`${t.name}:${t.language}`} className="template-row">
              <div className="row between wrap">
                <strong className="mono">{t.name}</strong>
                <span className="row">
                  <Badge>{t.language}</Badge>
                  {t.category && <Badge>{t.category.toLowerCase()}</Badge>}
                  <Badge tone={TEMPLATE_STATUS[t.status]}>{t.status.toLowerCase().replace(/_/g, ' ')}</Badge>
                </span>
              </div>
              <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>
                <WhatsAppText text={templatePreviewText(t)} />
              </div>
              {!t.supported && <p className="small error-text">{t.reason}</p>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Pick an approved template for a campaign and fill in its variables. */
export function TemplatePicker({ sessionId, value, onChange }: { sessionId: string; value: TemplateChoice | null | undefined; onChange: (choice: TemplateChoice | null) => void }) {
  const { data, error, loading, setData } = useApi<{ items: MetaTemplate[] }>(`/api/official/numbers/${sessionId}/templates`);
  const [picking, setPicking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const templates = data?.items ?? [];
  const usable = templates.filter(t => t.status === 'APPROVED' && t.supported);
  const current = templates.find(t => t.name === value?.name && t.language === value?.language) ?? null;

  const choose = (key: string) => {
    const t = templates.find(x => `${x.name}:${x.language}` === key);
    if (!t) return onChange(null);
    const params: Record<string, string> = {};
    // Sensible starting values: the first body variable is usually the customer's name.
    t.slots.forEach((slot, i) => {
      params[slot.key] = value?.name === t.name ? (value.params[slot.key] ?? '') : i === 0 && slot.key.startsWith('body:') ? '{{first_name|there}}' : '';
    });
    onChange({ name: t.name, language: t.language, params, headerMediaId: value?.name === t.name ? value.headerMediaId : null });
  };

  useEffect(() => {
    if (value && data && !current) onChange(null);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const mediaHeader = current && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(current.headerFormat);
  return (
    <div className="stack">
      <Callout>Official numbers start conversations with a Meta-approved template. Choose one, then fill in its blanks. You can use personalization like {'{{first_name|there}}'} or {'{{city}}'}.</Callout>
      <ErrorNote error={error} />
      <Field
        label="Approved template"
        hint={
          <span>
            {usable.length} of {templates.length} templates can be used.{' '}
            <button
              type="button"
              className="link-button"
              disabled={syncing}
              onClick={async () => {
                setSyncing(true);
                try {
                  setData(await post<{ items: MetaTemplate[] }>(`/api/official/numbers/${sessionId}/sync-templates`));
                } finally {
                  setSyncing(false);
                }
              }}
            >
              {syncing ? 'Syncing…' : 'Sync from Meta'}
            </button>
          </span>
        }
      >
        {loading && !data ? (
          <Loading />
        ) : (
          <select className="select" value={current ? `${current.name}:${current.language}` : ''} onChange={e => choose(e.target.value)}>
            <option value="">Choose a template…</option>
            {templates.map(t => (
              <option key={`${t.name}:${t.language}`} value={`${t.name}:${t.language}`} disabled={t.status !== 'APPROVED' || !t.supported}>
                {t.name} ({t.language}){t.status !== 'APPROVED' ? ` — ${t.status.toLowerCase()}` : !t.supported ? ' — not supported' : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      {current && value && (
        <>
          {mediaHeader && (
            <Field label={`Header ${current.headerFormat.toLowerCase()}`} hint={current.headerFormat === 'IMAGE' ? 'JPG or PNG.' : undefined}>
              {value.headerMediaId ? (
                <AttachedMedia mediaId={value.headerMediaId} onRemove={() => onChange({ ...value, headerMediaId: null })} />
              ) : (
                <div>
                  <Button size="sm" onClick={() => setPicking(true)}>
                    Choose {current.headerFormat.toLowerCase()}
                  </Button>
                </div>
              )}
            </Field>
          )}
          {current.slots.map(slot => (
            <Field key={slot.key} label={slot.label} hint={slot.hint}>
              <input
                className="input"
                value={value.params[slot.key] ?? ''}
                onChange={e => onChange({ ...value, params: { ...value.params, [slot.key]: e.target.value } })}
                placeholder={slot.key.startsWith('body:') ? '{{first_name|there}}' : ''}
              />
            </Field>
          ))}
        </>
      )}
      {picking && value && (
        <MediaPicker
          selectedId={value.headerMediaId}
          onClose={() => setPicking(false)}
          onPick={media => {
            onChange({ ...value, headerMediaId: media.id });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** Template in use for a variant, for previews. */
export function useTemplate(sessionId: string | null, choice: TemplateChoice | null | undefined): MetaTemplate | null {
  const [template, setTemplate] = useState<MetaTemplate | null>(null);
  useEffect(() => {
    if (!sessionId || !choice) return setTemplate(null);
    let live = true;
    get<{ items: MetaTemplate[] }>(`/api/official/numbers/${sessionId}/templates`)
      .then(r => live && setTemplate(r.items.find(t => t.name === choice.name && t.language === choice.language) ?? null))
      .catch(() => live && setTemplate(null));
    return () => {
      live = false;
    };
  }, [sessionId, choice?.name, choice?.language]); // eslint-disable-line react-hooks/exhaustive-deps
  return template;
}
