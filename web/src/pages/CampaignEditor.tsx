import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  get,
  patch,
  post,
  useApi,
  errorMessage,
  type Audience,
  type Campaign,
  type CampaignOptions,
  type ContactFilter,
  type Segment,
  type Settings,
  type SystemInfo,
  type Variant,
} from '../api';
import { Button, Callout, Card, ErrorNote, Field, Loading, NumberInput, PageHeader, Toggle, useToast } from '../components/ui';
import { IconArrowLeft, IconPlus, IconSend, IconX } from '../components/icons';
import { Composer, MessagePreview } from '../components/composer';
import { SessionSelect, TagPicker, useSessions, useTags } from '../components/pickers';
import { TemplatePicker, templatePreviewText, useTemplate } from '../components/official';
import { AUDIENCE_HANDOFF } from './Contacts';
import { formatDuration, formatNumber, fromLocalInput, toLocalInput } from '../format';

type Step = 'audience' | 'message' | 'sending' | 'review';
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'audience', label: 'Audience' },
  { id: 'message', label: 'Message' },
  { id: 'sending', label: 'Sending' },
  { id: 'review', label: 'Review' },
];

interface Preview {
  matched: number;
  eligible: number;
  excluded: { optedOut: number; noConsent: number; invalid: number };
  sample: Array<{ id: number; name: string | null; phone: string }>;
}

const KEYS: Variant['key'][] = ['A', 'B', 'C'];

function rebalance(variants: Variant[]): Variant[] {
  const base = Math.floor(100 / variants.length);
  return variants.map((v, i) => ({ ...v, weight: i === 0 ? 100 - base * (variants.length - 1) : base }));
}

export function CampaignEditorPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: settings } = useApi<Settings>('/api/settings');
  const { data: system } = useApi<SystemInfo>('/api/system');
  const { data: segments } = useApi<Segment[]>('/api/segments');
  const { data: tags } = useTags();
  const { data: numbers } = useSessions();

  const [campaignId, setCampaignId] = useState<number | null>(id ? Number(id) : null);
  const [loaded, setLoaded] = useState(!id);
  const [status, setStatus] = useState<Campaign['status']>('draft');
  const [step, setStep] = useState<Step>('audience');
  const [name, setName] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [audience, setAudience] = useState<Audience>({ type: 'all', excludeTagIds: [] });
  const [variants, setVariants] = useState<Variant[]>([{ key: 'A', body: '', mediaId: null, weight: 100 }]);
  const [activeVariant, setActiveVariant] = useState<Variant['key']>('A');
  const [options, setOptions] = useState<CampaignOptions | null>(null);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(null));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testPhone, setTestPhone] = useState('');

  // Initial state: an existing draft, a segment shortcut, or a selection handed over from Contacts.
  useEffect(() => {
    if (id) {
      get<Campaign>(`/api/campaigns/${id}`)
        .then(c => {
          if (c.status !== 'draft' && c.status !== 'scheduled' && c.status !== 'paused') {
            navigate(`/campaigns/${c.id}`, { replace: true });
            return;
          }
          setStatus(c.status);
          setName(c.name);
          setSessionId(c.sessionId);
          setAudience(c.audience);
          setVariants(c.variants);
          setOptions(c.options);
          if (c.scheduledAt) {
            setScheduleLater(true);
            setScheduledAt(toLocalInput(c.scheduledAt));
          }
          setLoaded(true);
        })
        .catch(err => setError(errorMessage(err)));
      return;
    }
    const segment = Number(search.get('segment'));
    if (segment) setAudience({ type: 'segment', segmentId: segment, excludeTagIds: [] });
    if (search.get('audience') === 'selection') {
      const raw = sessionStorage.getItem(AUDIENCE_HANDOFF);
      sessionStorage.removeItem(AUDIENCE_HANDOFF);
      if (raw) {
        const handoff = JSON.parse(raw) as { contactIds?: number[]; filter?: ContactFilter };
        if (handoff.contactIds) setAudience({ type: 'contacts', contactIds: handoff.contactIds, excludeTagIds: [] });
        else if (handoff.filter) {
          post<{ ids: number[] }>('/api/contacts/ids', { filter: handoff.filter })
            .then(r => setAudience({ type: 'contacts', contactIds: r.ids, excludeTagIds: [] }))
            .catch(err => setError(errorMessage(err)));
        }
      }
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!options && settings) {
      setOptions({ perMinute: settings.sending.defaultPerMinute, respectQuietHours: true, requireOptIn: false, appendOptOut: true, trackLinks: true, validateNumbers: false });
    }
    if (!sessionId && settings?.defaultSessionId && !id) setSessionId(settings.defaultSessionId);
  }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const audienceValid =
    (audience.type !== 'segment' || !!audience.segmentId) && (audience.type !== 'tags' || audience.tagIds.length > 0) && (audience.type !== 'contacts' || audience.contactIds.length > 0);

  useEffect(() => {
    if (!options || !audienceValid) return;
    const timer = setTimeout(() => {
      post<Preview>('/api/campaigns/audience-preview', { audience, options: { requireOptIn: options.requireOptIn } })
        .then(setPreview)
        .catch(err => setError(errorMessage(err)));
    }, 250);
    return () => clearTimeout(timer);
  }, [audience, options?.requireOptIn, audienceValid]); // eslint-disable-line react-hooks/exhaustive-deps

  const variant = variants.find(v => v.key === activeVariant) ?? variants[0];
  // Official (Meta Cloud API) numbers send approved templates instead of free text.
  const official = !!sessionId && numbers?.items.find(n => n.id === sessionId)?.channel === 'official';
  const previewTemplate = useTemplate(official ? sessionId : null, variant.template);
  const messageValid =
    variants.every(v =>
      official
        ? !!v.template && Object.values(v.template.params).every(p => p.trim() !== '')
        : v.body.trim() || v.mediaId,
    ) && variants.reduce((s, v) => s + v.weight, 0) === 100;
  const rate = options ? Math.min(options.perMinute, settings?.sending.sessionMaxPerMinute ?? options.perMinute) : 1;
  const estimate = preview ? Math.ceil(preview.eligible / rate) : 0;
  const footer = options?.appendOptOut ? (settings?.compliance.optOutFooter ?? null) : null;
  const hasLinks = useMemo(() => !official && variants.some(v => /https?:\/\//.test(v.body)), [variants, official]);

  const payload = () => ({
    name: name.trim() || 'Untitled campaign',
    sessionId,
    audience,
    // Keep only what the chosen number can send: a template on official numbers, text/media otherwise.
    variants: variants.map(v => (official ? v : { ...v, template: null })),
    options,
    scheduledAt: scheduleLater ? fromLocalInput(scheduledAt) : null,
  });

  const save = async (): Promise<number> => {
    if (campaignId) {
      await patch(`/api/campaigns/${campaignId}`, payload());
      return campaignId;
    }
    const created = await post<Campaign>('/api/campaigns', payload());
    setCampaignId(created.id);
    window.history.replaceState(null, '', `/campaigns/${created.id}/edit`);
    return created.id;
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!loaded || !options) return <Loading />;

  const stepIndex = STEPS.findIndex(s => s.id === step);
  const canNext = step === 'audience' ? audienceValid && (preview?.eligible ?? 0) > 0 : step === 'message' ? messageValid : true;

  return (
    <div className="page">
      <PageHeader
        back={
          <Link to="/campaigns" className="row small">
            <IconArrowLeft size={14} /> Campaigns
          </Link>
        }
        title={name || (campaignId ? 'Edit campaign' : 'New campaign')}
        actions={
          <Button
            loading={busy === 'draft'}
            onClick={() =>
              run('draft', async () => {
                await save();
                toast.success('Draft saved');
              })
            }
          >
            Save draft
          </Button>
        }
      />
      <nav className="steps" aria-label="Campaign steps">
        {STEPS.map((s, i) => (
          <button key={s.id} type="button" className={`${s.id === step ? 'active' : ''} ${i < stepIndex ? 'done' : ''}`} onClick={() => setStep(s.id)}>
            <span className="n">{i + 1}</span>
            {s.label}
          </button>
        ))}
      </nav>
      <ErrorNote error={error} />
      {status === 'paused' && <Callout tone="warn">This campaign is paused. You can fix the message or pacing; the audience is fixed once sending has started.</Callout>}

      {step === 'audience' && (
        <div className="grid sidebar-right">
          <Card title="Who should get this?">
            <div className="stack loose">
              <Field label="Campaign name">
                <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Diwali offer 2026" />
              </Field>
              <div className="stack tight">
                {(
                  [
                    { type: 'all', title: 'All contacts', text: 'Everyone in your list who has not opted out.' },
                    { type: 'segment', title: 'A segment', text: 'A saved audience, re-evaluated when sending starts.' },
                    { type: 'tags', title: 'Contacts with tags', text: 'Anyone with at least one of the chosen tags.' },
                    ...(audience.type === 'contacts' ? [{ type: 'contacts', title: 'Selected contacts', text: `${formatNumber(audience.contactIds.length)} contacts picked on the Contacts page.` }] : []),
                  ] as Array<{ type: Audience['type']; title: string; text: string }>
                ).map(o => (
                  <label key={o.type} className={`option-card ${audience.type === o.type ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="audience"
                      disabled={status === 'paused'}
                      checked={audience.type === o.type}
                      onChange={() => {
                        if (o.type === 'all') setAudience({ type: 'all', excludeTagIds: audience.excludeTagIds });
                        if (o.type === 'segment') setAudience({ type: 'segment', segmentId: segments?.[0]?.id ?? 0, excludeTagIds: audience.excludeTagIds });
                        if (o.type === 'tags') setAudience({ type: 'tags', tagIds: [], excludeTagIds: audience.excludeTagIds });
                      }}
                    />
                    <span>
                      <strong>{o.title}</strong>
                      <br />
                      <span className="small secondary">{o.text}</span>
                    </span>
                  </label>
                ))}
              </div>
              {audience.type === 'segment' && (
                <Field label="Segment">
                  {segments && segments.length === 0 ? (
                    <p className="secondary small">
                      No segments yet. <Link to="/segments">Create one</Link>.
                    </p>
                  ) : (
                    <select className="select" value={audience.segmentId || ''} onChange={e => setAudience({ ...audience, segmentId: Number(e.target.value) })} disabled={status === 'paused'}>
                      <option value="">Choose a segment…</option>
                      {segments?.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({formatNumber(s.count ?? 0)})
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              {audience.type === 'tags' && (
                <Field label="Include contacts tagged with any of">
                  <TagPicker value={audience.tagIds} onChange={tagIds => setAudience({ ...audience, tagIds })} allowCreate={false} />
                </Field>
              )}
              <Field label="Exclude contacts tagged with" hint="e.g. customers who already bought, or staff numbers.">
                <TagPicker value={audience.excludeTagIds} onChange={excludeTagIds => setAudience({ ...audience, excludeTagIds })} allowCreate={false} placeholder="Type to exclude a tag…" suggest={false} />
              </Field>
              <Toggle
                checked={options.requireOptIn}
                onChange={requireOptIn => setOptions({ ...options, requireOptIn })}
                label="Only people who opted in"
                description="Recommended for promotional messages. Contacts without a recorded opt-in are left out."
              />
            </div>
          </Card>
          <Card title="Audience size">
            {!audienceValid ? (
              <p className="secondary">{audience.type === 'tags' ? 'Choose at least one tag.' : 'Choose a segment.'}</p>
            ) : !preview ? (
              <Loading />
            ) : (
              <div className="stack">
                <div>
                  <div className="hero-value">{formatNumber(preview.eligible)}</div>
                  <div className="secondary">will receive this campaign</div>
                </div>
                <dl className="kv">
                  <dt>Matched</dt>
                  <dd className="num">{formatNumber(preview.matched)}</dd>
                  <dt>Opted out</dt>
                  <dd className="num">−{formatNumber(preview.excluded.optedOut)}</dd>
                  {options.requireOptIn && (
                    <>
                      <dt>No opt-in</dt>
                      <dd className="num">−{formatNumber(preview.excluded.noConsent)}</dd>
                    </>
                  )}
                  <dt>Not on WhatsApp</dt>
                  <dd className="num">−{formatNumber(preview.excluded.invalid)}</dd>
                </dl>
                {audience.excludeTagIds.length > 0 && tags && (
                  <p className="small secondary">Excluding {tags.filter(t => audience.excludeTagIds.includes(t.id)).map(t => t.name).join(', ')}.</p>
                )}
                <p className="hint">Opt-outs are checked again right before each message, so anyone who replies STOP mid-campaign is skipped.</p>
              </div>
            )}
          </Card>
        </div>
      )}

      {step === 'message' && (
        <div className="grid sidebar-right">
          <Card
            title="Message"
            subtitle={variants.length > 1 ? 'Each contact gets one version, split by the percentages below.' : 'Add a second version to A/B test wording, offers or media.'}
            actions={
              variants.length < 3 && (
                <Button
                  size="sm"
                  icon={<IconPlus size={14} />}
                  onClick={() => {
                    const key = KEYS[variants.length];
                    setVariants(rebalance([...variants, { key, body: variant.body, mediaId: variant.mediaId, template: variant.template, weight: 0 }]));
                    setActiveVariant(key);
                  }}
                >
                  Add version {KEYS[variants.length]}
                </Button>
              )
            }
          >
            <div className="stack">
              {variants.length > 1 && (
                <div className="row wrap">
                  {variants.map(v => (
                    <div key={v.key} className={`option-card ${activeVariant === v.key ? 'selected' : ''}`} style={{ padding: '6px 10px', alignItems: 'center' }} onClick={() => setActiveVariant(v.key)}>
                      <strong>Version {v.key}</strong>
                      <input
                        className="input sm"
                        type="number"
                        min={0}
                        max={100}
                        value={v.weight}
                        style={{ width: 70 }}
                        aria-label={`Share for version ${v.key}`}
                        onClick={e => e.stopPropagation()}
                        onChange={e => setVariants(variants.map(x => (x.key === v.key ? { ...x, weight: Number(e.target.value) } : x)))}
                      />
                      <span className="small">%</span>
                      {v.key !== 'A' && (
                        <button
                          type="button"
                          className="btn ghost icon sm"
                          aria-label={`Remove version ${v.key}`}
                          onClick={e => {
                            e.stopPropagation();
                            const rest = variants.filter(x => x.key !== v.key).map((x, i) => ({ ...x, key: KEYS[i] }));
                            setVariants(rebalance(rest));
                            setActiveVariant('A');
                          }}
                        >
                          <IconX size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                  {variants.reduce((s, v) => s + v.weight, 0) !== 100 && <span className="error-text">Shares must add up to 100%.</span>}
                </div>
              )}
              <Field label="Send from" hint={<Link to="/numbers">Manage numbers</Link>}>
                <SessionSelect value={sessionId} onChange={setSessionId} />
              </Field>
              {official && sessionId ? (
                <TemplatePicker
                  key={`${sessionId}:${variant.key}`}
                  sessionId={sessionId}
                  value={variant.template}
                  onChange={template => setVariants(variants.map(v => (v.key === variant.key ? { ...v, template } : v)))}
                />
              ) : (
                <Composer
                  key={variant.key}
                  body={variant.body}
                  mediaId={variant.mediaId}
                  onChange={next => setVariants(variants.map(v => (v.key === variant.key ? { ...v, body: next.body, mediaId: next.mediaId } : v)))}
                />
              )}
              <div className="divider" />
              {official ? (
                <p className="hint">
                  Unsubscribe line and link tracking don't apply to templates: add a “Stop promotions” button to the template in Meta, and customers who tap it are opted out automatically.
                </p>
              ) : (
                <>
              <Toggle
                checked={options.appendOptOut}
                onChange={appendOptOut => setOptions({ ...options, appendOptOut })}
                label="Add unsubscribe line"
                description={`Adds “${settings?.compliance.optOutFooter ?? ''}” at the end. STOP replies are handled automatically.`}
              />
              <Toggle
                checked={options.trackLinks && !!system?.trackingEnabled}
                disabled={!system?.trackingEnabled}
                onChange={trackLinks => setOptions({ ...options, trackLinks })}
                label="Track link clicks"
                description={
                  system?.trackingEnabled
                    ? 'Links are replaced with short tracked links, so you can see who clicked.'
                    : 'Set PUBLIC_URL on the server to enable click tracking.'
                }
              />
                </>
              )}
            </div>
          </Card>
          <Card title={variants.length > 1 ? `Preview: version ${variant.key}` : 'Preview'}>
            {official ? (
              previewTemplate && variant.template ? (
                <MessagePreview body={templatePreviewText(previewTemplate, variant.template.params)} mediaId={variant.template.headerMediaId} footer={null} />
              ) : (
                <p className="secondary small">Choose a template to see a preview.</p>
              )
            ) : (
              <MessagePreview body={variant.body} mediaId={variant.mediaId} footer={footer} />
            )}
            {hasLinks && options.trackLinks && system?.trackingEnabled && <p className="hint" style={{ marginTop: 8 }}>Links will be replaced with tracked short links when sent.</p>}
          </Card>
        </div>
      )}

      {step === 'sending' && (
        <Card title="Sending">
          <div className="stack loose">
            <div className="grid cols-2">
              <Field label="Send from" hint={<Link to="/numbers">Manage numbers</Link>}>
                <SessionSelect value={sessionId} onChange={setSessionId} />
              </Field>
              <Field
                label="Pace (messages per minute)"
                hint={`Each number is capped at ${settings?.sending.sessionMaxPerMinute ?? '–'}/min and ${formatNumber(settings?.sending.dailyCapPerSession ?? 0)}/day. Slower is safer.`}
              >
                <NumberInput min={1} max={60} value={options.perMinute} onChange={perMinute => setOptions({ ...options, perMinute })} />
              </Field>
            </div>
            {preview && (
              <Callout>
                About {formatDuration(Math.max(1, estimate))} to reach {formatNumber(preview.eligible)} people at {rate}/min
                {settings && preview.eligible > settings.sending.dailyCapPerSession ? `, spread over several days by the daily limit of ${formatNumber(settings.sending.dailyCapPerSession)}` : ''}.
              </Callout>
            )}
            <Toggle
              checked={options.respectQuietHours}
              onChange={respectQuietHours => setOptions({ ...options, respectQuietHours })}
              label="Respect quiet hours"
              description={
                settings?.quietHours.enabled
                  ? `No sends between ${settings.quietHours.start} and ${settings.quietHours.end} (${settings.timezone}); the campaign waits and continues after.`
                  : 'Quiet hours are turned off in Settings.'
              }
            />
            <Toggle
              checked={options.validateNumbers}
              onChange={validateNumbers => setOptions({ ...options, validateNumbers })}
              label="Check each number is on WhatsApp first"
              disabled={official}
              description={
                official
                  ? 'Not needed on official numbers: Meta reports undeliverable numbers after sending.'
                  : 'Skips numbers without WhatsApp instead of sending into the void. Adds a lookup per new number.'
              }
            />
            <div className="divider" />
            <div className="stack">
              <span className="label">When</span>
              <div className="row wrap">
                <label className={`option-card ${!scheduleLater ? 'selected' : ''}`}>
                  <input type="radio" checked={!scheduleLater} onChange={() => setScheduleLater(false)} />
                  <strong>Send now</strong>
                </label>
                <label className={`option-card ${scheduleLater ? 'selected' : ''}`}>
                  <input type="radio" checked={scheduleLater} onChange={() => setScheduleLater(true)} />
                  <strong>Schedule</strong>
                </label>
                {scheduleLater && <input className="input" style={{ width: 'auto' }} type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} aria-label="Send at" />}
              </div>
            </div>
          </div>
        </Card>
      )}

      {step === 'review' && (
        <div className="grid sidebar-right">
          <Card title="Review">
            <dl className="kv">
              <dt>Name</dt>
              <dd>{name || 'Untitled campaign'}</dd>
              <dt>Audience</dt>
              <dd>
                {formatNumber(preview?.eligible ?? 0)} contacts
                {options.requireOptIn ? ' (opted in only)' : ''}
              </dd>
              <dt>Versions</dt>
              <dd>{variants.length === 1 ? 'One message' : variants.map(v => `${v.key} ${v.weight}%`).join(' · ')}</dd>
              <dt>Pace</dt>
              <dd>
                {rate}/min{options.respectQuietHours && settings?.quietHours.enabled ? `, paused ${settings.quietHours.start}–${settings.quietHours.end}` : ''}
              </dd>
              <dt>Starts</dt>
              <dd>{scheduleLater ? new Date(fromLocalInput(scheduledAt)).toLocaleString() : 'Immediately'}</dd>
              {official && (
                <>
                  <dt>Template</dt>
                  <dd>{variants.map(v => v.template?.name ?? '—').join(' · ')} (Meta bills your account per message)</dd>
                </>
              )}
              <dt>Extras</dt>
              <dd>
                {[!official && options.appendOptOut && 'unsubscribe line', options.trackLinks && system?.trackingEnabled && 'click tracking', options.validateNumbers && 'number check'].filter(Boolean).join(', ') || 'None'}
              </dd>
            </dl>
            {!sessionId && <Callout tone="warn">Choose a number to send from on the Sending step.</Callout>}
          </Card>
          <Card title="Send yourself a test">
            <div className="stack">
              <p className="secondary small">See exactly how it looks on a phone before it goes out. Uses your contact data if the number is in your list.</p>
              <input className="input" placeholder="+91 98765 43210" value={testPhone} onChange={e => setTestPhone(e.target.value)} aria-label="Test phone number" />
              <div className="row wrap">
                {variants.map(v => (
                  <Button
                    key={v.key}
                    size="sm"
                    icon={<IconSend size={14} />}
                    loading={busy === `test-${v.key}`}
                    disabled={!testPhone || !sessionId}
                    onClick={() =>
                      run(`test-${v.key}`, async () => {
                        const cid = await save();
                        await post(`/api/campaigns/${cid}/test`, { phone: testPhone, variant: v.key, sessionId });
                        toast.success(`Test of version ${v.key} sent`);
                      })
                    }
                  >
                    {variants.length > 1 ? `Send version ${v.key}` : 'Send test'}
                  </Button>
                ))}
              </div>
            </div>
          </Card>
        </div>
      )}

      <div className="row between">
        <Button disabled={stepIndex === 0} onClick={() => setStep(STEPS[stepIndex - 1].id)}>
          Back
        </Button>
        {step !== 'review' ? (
          <Button variant="primary" disabled={!canNext} onClick={() => setStep(STEPS[stepIndex + 1].id)}>
            Continue
          </Button>
        ) : status === 'paused' ? (
          <Button
            variant="primary"
            loading={busy === 'launch'}
            onClick={() =>
              run('launch', async () => {
                const cid = await save();
                await post(`/api/campaigns/${cid}/resume`);
                toast.success('Campaign resumed');
                navigate(`/campaigns/${cid}`);
              })
            }
          >
            Save and resume
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<IconSend size={16} />}
            loading={busy === 'launch'}
            disabled={!sessionId || !messageValid || !audienceValid}
            onClick={() =>
              run('launch', async () => {
                const cid = await save();
                await post(`/api/campaigns/${cid}/launch`, { scheduledAt: scheduleLater ? fromLocalInput(scheduledAt) : null });
                toast.success(scheduleLater ? 'Campaign scheduled' : 'Campaign started');
                navigate(`/campaigns/${cid}`);
              })
            }
          >
            {scheduleLater ? 'Schedule campaign' : `Send to ${formatNumber(preview?.eligible ?? 0)} contacts`}
          </Button>
        )}
      </div>
    </div>
  );
}
