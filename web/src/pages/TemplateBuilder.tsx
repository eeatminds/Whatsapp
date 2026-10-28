import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, post, put, useApi, errorMessage, ApiError, type DraftButton, type MetaTemplate, type TemplateDraft, type TemplateProblem } from '../api';
import { Badge, Button, Callout, Card, Field, Loading, PageHeader, Segmented, Toggle, useToast } from '../components/ui';
import { IconAlert, IconArrowLeft, IconCheck, IconPlus, IconTrash } from '../components/icons';
import { AttachedMedia, MediaPicker } from '../components/media';
import { StatusBadges, TemplatePreview, previewOfDraft, rejectionHelp, templateStatus } from '../components/meta-templates';

interface Options {
  languages: Array<{ code: string; name: string }>;
  trackingPrefix: string | null;
}

const BLANK_DRAFT: TemplateDraft = {
  name: '',
  language: 'en',
  category: 'MARKETING',
  format: 'standard',
  header: { type: 'none', text: '', mediaId: null },
  body: '',
  footer: '',
  buttons: [{ type: 'quick_reply', text: 'Stop promotions' }],
  samples: {},
  offer: { text: '', expires: true },
  cardFormat: 'image',
  cards: [],
};

/** Ready-made starting points for people who haven't written a template before. */
const STARTERS: Array<{ label: string; draft: Partial<TemplateDraft> }> = [
  {
    label: 'Festival offer',
    draft: {
      name: 'festival_offer',
      category: 'MARKETING',
      format: 'standard',
      header: { type: 'image', text: '', mediaId: null },
      body: 'Hi {{first_name}} 🪔\n\nOur *festival specials* are here! Get {{discount}} off on everything at our {{city}} store till Sunday.\n\nUse code {{offer_code}} at checkout.',
      footer: 'Not interested? Tap Stop promotions',
      buttons: [
        { type: 'url', text: 'Shop now', url: '', mode: 'static', example: '' },
        { type: 'quick_reply', text: 'Stop promotions' },
      ],
    },
  },
  {
    label: 'New arrivals (carousel)',
    draft: {
      name: 'new_arrivals',
      category: 'MARKETING',
      format: 'carousel',
      body: 'Hi {{first_name}}, our new collection has just arrived. Swipe to see what is new this week!',
      cards: [0, 1, 2].map(() => ({ mediaId: null, body: 'Now only {{price}}', buttons: [{ type: 'url' as const, text: 'Buy now', url: '', mode: 'static' as const, example: '' }] })),
    },
  },
  {
    label: 'Limited-time deal',
    draft: {
      name: 'limited_time_deal',
      category: 'MARKETING',
      format: 'offer',
      header: { type: 'image', text: '', mediaId: null },
      offer: { text: 'Weekend deal', expires: true },
      body: 'Hi {{first_name}}, enjoy {{discount}} off on your next order this weekend only. Tap below to copy your code.',
      buttons: [
        { type: 'copy_code', example: 'WEEKEND20' },
        { type: 'url', text: 'Order now', url: '', mode: 'static', example: '' },
      ],
    },
  },
  {
    label: 'Order update',
    draft: {
      name: 'order_update',
      category: 'UTILITY',
      format: 'standard',
      header: { type: 'text', text: 'Order {{order_number}}', mediaId: null },
      body: 'Hi {{first_name}}, your order {{order_number}} has been shipped and will reach you by {{date}}. Thank you for shopping with us!',
      footer: '',
      buttons: [{ type: 'url', text: 'Track order', url: '', mode: 'dynamic', example: '10234' }],
    },
  },
  {
    label: 'Appointment reminder',
    draft: {
      name: 'appointment_reminder',
      category: 'UTILITY',
      format: 'standard',
      header: { type: 'none', text: '', mediaId: null },
      body: 'Hi {{first_name}}, this is a reminder of your appointment on {{date}} at {{time}}. Reply if you need to change it.',
      footer: '',
      buttons: [
        { type: 'quick_reply', text: 'Confirm' },
        { type: 'quick_reply', text: 'Reschedule' },
      ],
    },
  },
];

const BLANK_CHOICES: Array<{ name: string; label: string }> = [
  { name: 'first_name', label: "Customer's first name" },
  { name: 'name', label: "Customer's full name" },
  { name: 'city', label: 'City' },
  { name: 'offer_code', label: 'Offer code' },
  { name: 'discount', label: 'Discount' },
  { name: 'price', label: 'Price' },
  { name: 'order_number', label: 'Order number' },
  { name: 'date', label: 'Date' },
  { name: 'time', label: 'Time' },
  { name: 'amount', label: 'Amount' },
];

const SAMPLE_GUESS: Record<string, string> = {
  first_name: 'Priya',
  name: 'Priya Sharma',
  last_name: 'Sharma',
  city: 'Pune',
  offer_code: 'DIWALI20',
  discount: '20%',
  price: '₹499',
  order_number: '10234',
  date: '25 October',
  time: '11:30 am',
  amount: '₹1,250',
  phone: '+91 98450 12345',
};

const BLANK = /\{\{\s*([^{}]*?)\s*\}\}/g;
const blankNames = (draft: TemplateDraft): string[] => {
  const texts = [draft.format !== 'carousel' && draft.header.type === 'text' ? draft.header.text : '', draft.body, ...(draft.format === 'carousel' ? draft.cards.map(c => c.body) : [])];
  return [...new Set(texts.flatMap(t => [...t.matchAll(BLANK)].map(m => m[1])).filter(n => /^[a-z][a-z0-9_]*$/.test(n)))];
};
const label = (name: string) => {
  const known = BLANK_CHOICES.find(b => b.name === name);
  if (known) return known.label;
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 512);

/** A text box with WhatsApp formatting buttons and a menu to insert blanks. */
function RichText({ value, onChange, max, rows = 6, placeholder, singleLine }: {
  value: string;
  onChange: (value: string) => void;
  max: number;
  rows?: number;
  placeholder?: string;
  singleLine?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [custom, setCustom] = useState('');
  const [askName, setAskName] = useState(false);
  const insert = (before: string, after = '') => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + before.length + (end - start) + after.length;
      el?.setSelectionRange(pos, pos);
    });
  };
  const addBlank = (name: string) => insert(`{{${name}}}`);
  return (
    <div className="rich-text">
      <div className="rich-toolbar">
        {!singleLine && (
          <>
            <button type="button" title="Bold" onClick={() => insert('*', '*')}>
              <strong>B</strong>
            </button>
            <button type="button" title="Italic" onClick={() => insert('_', '_')}>
              <em>I</em>
            </button>
            <button type="button" title="Strikethrough" onClick={() => insert('~', '~')}>
              <s>S</s>
            </button>
            <button type="button" title="Monospace" onClick={() => insert('```', '```')}>
              {'</>'}
            </button>
          </>
        )}
        <select
          className="select sm"
          value=""
          aria-label="Insert a blank"
          onChange={e => {
            if (e.target.value === '__custom') setAskName(true);
            else if (e.target.value) addBlank(e.target.value);
          }}
        >
          <option value="">+ Insert a blank…</option>
          {BLANK_CHOICES.map(b => (
            <option key={b.name} value={b.name}>
              {b.label}
            </option>
          ))}
          <option value="__custom">Something else…</option>
        </select>
        {askName && (
          <span className="row" style={{ gap: 4 }}>
            <input className="input sm" style={{ width: 150 }} placeholder="e.g. product" value={custom} onChange={e => setCustom(slug(e.target.value))} autoFocus />
            <Button
              size="sm"
              disabled={!/^[a-z][a-z0-9_]*$/.test(custom)}
              onClick={() => {
                addBlank(custom);
                setCustom('');
                setAskName(false);
              }}
            >
              Add
            </Button>
          </span>
        )}
        <span className={`small ${value.length > max ? 'error-text' : 'muted'}`} style={{ marginLeft: 'auto' }}>
          {value.length}/{max}
        </span>
      </div>
      {singleLine ? (
        <input ref={ref} className="input" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
      ) : (
        <textarea ref={ref} className="textarea" rows={rows} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
      )}
    </div>
  );
}

function Issues({ problems, field, exact }: { problems: TemplateProblem[]; field: string; exact?: boolean }) {
  const mine = problems.filter(p => (exact ? p.field === field : p.field === field || p.field.startsWith(`${field}.`)));
  if (!mine.length) return null;
  return (
    <ul className="tpl-issues">
      {mine.map((p, i) => (
        <li key={i} className={p.level}>
          <IconAlert size={13} /> {p.message}
        </li>
      ))}
    </ul>
  );
}

const BUTTON_KINDS: Record<DraftButton['type'], string> = { quick_reply: 'Quick reply', url: 'Website link', phone: 'Call button', copy_code: 'Copy offer code' };

function ButtonRow({ button, onChange, onRemove, onMove, trackingPrefix, fixed }: {
  button: DraftButton;
  onChange: (b: DraftButton) => void;
  onRemove?: () => void;
  onMove?: (by: -1 | 1) => void;
  trackingPrefix: string | null;
  fixed?: boolean;
}) {
  return (
    <div className="tpl-button-row">
      <div className="row between">
        <Badge>{button.type === 'quick_reply' && /^stop promotions?$/i.test(button.text) ? 'Unsubscribe (Stop promotions)' : BUTTON_KINDS[button.type]}</Badge>
        {!fixed && (
          <span className="row" style={{ gap: 2 }}>
            {onMove && (
              <>
                <button type="button" className="btn ghost icon sm" aria-label="Move up" onClick={() => onMove(-1)}>
                  ↑
                </button>
                <button type="button" className="btn ghost icon sm" aria-label="Move down" onClick={() => onMove(1)}>
                  ↓
                </button>
              </>
            )}
            {onRemove && (
              <button type="button" className="btn ghost icon sm" aria-label="Remove button" onClick={onRemove}>
                <IconTrash size={14} />
              </button>
            )}
          </span>
        )}
      </div>
      {button.type !== 'copy_code' && (
        <input className="input sm" value={button.text} maxLength={40} placeholder="Button text (up to 25 characters)" onChange={e => onChange({ ...button, text: e.target.value })} />
      )}
      {button.type === 'url' && (
        <>
          <select className="select sm" value={button.mode} onChange={e => onChange({ ...button, mode: e.target.value as 'static' | 'dynamic' | 'tracked' })}>
            <option value="static">Same link for everyone</option>
            <option value="dynamic">The end of the link changes per message (e.g. order number)</option>
            {trackingPrefix && <option value="tracked">Count taps (each campaign chooses where it opens)</option>}
          </select>
          {button.mode !== 'tracked' ? (
            <input
              className="input sm"
              value={button.url}
              placeholder={button.mode === 'dynamic' ? 'https://your-shop.com/orders/' : 'https://your-shop.com'}
              onChange={e => onChange({ ...button, url: e.target.value.trim() })}
            />
          ) : (
            <span className="hint">Taps go through your WA Reach link and show in each campaign’s report. You choose the real page when you send.</span>
          )}
          {button.mode === 'dynamic' && (
            <input className="input sm" value={button.example} placeholder="Example ending, e.g. 10234" onChange={e => onChange({ ...button, example: e.target.value.trim() })} />
          )}
        </>
      )}
      {button.type === 'phone' && <input className="input sm" value={button.phone} placeholder="+91 98450 12345" onChange={e => onChange({ ...button, phone: e.target.value })} />}
      {button.type === 'copy_code' && (
        <input className="input sm" value={button.example} maxLength={20} placeholder="Example code, e.g. DIWALI20 (each campaign sets the real one)" onChange={e => onChange({ ...button, example: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
      )}
    </div>
  );
}

function newButton(type: DraftButton['type']): DraftButton {
  switch (type) {
    case 'quick_reply':
      return { type, text: '' };
    case 'url':
      return { type, text: 'Visit website', url: '', mode: 'static', example: '' };
    case 'phone':
      return { type, text: 'Call us', phone: '' };
    case 'copy_code':
      return { type, example: '' };
  }
}

function Section({ title, subtitle, children, id }: { title: string; subtitle?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <Card title={title} subtitle={subtitle}>
      <div className="stack" id={id}>
        {children}
      </div>
    </Card>
  );
}

export function TemplateBuilderPage() {
  const { number = '', templateId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const editingId = templateId && templateId !== 'new' ? Number(templateId) : null;
  const from = params.get('from');
  const as = params.get('as');
  const { data: options } = useApi<Options>('/api/official/template-options');
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [existing, setExisting] = useState<MetaTemplate | null>(null);
  const [source, setSource] = useState<MetaTemplate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problems, setProblems] = useState<TemplateProblem[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<'draft' | 'submit' | null>(null);
  const [picking, setPicking] = useState<'header' | number | null>(null);
  // What a standard message had, so trying the carousel and switching back loses nothing.
  const stash = useRef<Pick<TemplateDraft, 'header' | 'footer' | 'buttons'> | null>(null);
  const base = `/api/official/numbers/${encodeURIComponent(number)}/templates`;
  const back = `/templates?tab=meta&number=${encodeURIComponent(number)}`;

  // Load the template being edited, the one being copied, or start blank.
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        if (editingId) {
          const res = await get<{ template: MetaTemplate; draft: TemplateDraft }>(`${base}/${editingId}`);
          if (!live) return;
          setExisting(res.template);
          setDraft(res.draft);
        } else if (from) {
          const res = await get<{ template: MetaTemplate; draft: TemplateDraft }>(`${base}/${from}`);
          if (!live) return;
          setSource(res.template);
          setDraft(as === 'language' ? { ...res.draft, language: '' } : { ...res.draft, name: `${res.draft.name}_copy`.slice(0, 512) });
        } else {
          setDraft(BLANK_DRAFT);
        }
      } catch (err) {
        if (live) setLoadError(errorMessage(err));
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [editingId, from, as, base]);

  // Fill in examples for well-known blanks as they are added.
  const names = useMemo(() => (draft ? blankNames(draft) : []), [draft]);
  useEffect(() => {
    if (!draft) return;
    const missing = names.filter(n => draft.samples[n] === undefined && SAMPLE_GUESS[n]);
    if (missing.length) setDraft({ ...draft, samples: { ...draft.samples, ...Object.fromEntries(missing.map(n => [n, SAMPLE_GUESS[n]])) } });
  }, [names]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check against Meta's rules as the business types.
  useEffect(() => {
    if (!draft) return;
    setChecking(true);
    const timer = setTimeout(() => {
      post<{ problems: TemplateProblem[] }>(`${base}/check${editingId ? `?templateId=${editingId}` : ''}`, { draft })
        .then(r => setProblems(r.problems))
        .catch(() => undefined)
        .finally(() => setChecking(false));
    }, 450);
    return () => clearTimeout(timer);
  }, [draft, base, editingId]);

  if (loadError) {
    return (
      <div className="page">
        <Callout tone="danger">{loadError}</Callout>
      </div>
    );
  }
  if (!draft || !options) return <Loading />;

  const inMeta = !!existing && existing.status !== 'DRAFT';
  const lockedCategory = inMeta && existing?.status === 'APPROVED';
  const marketing = draft.category === 'MARKETING';
  const set = (patch: Partial<TemplateDraft>) => setDraft({ ...draft, ...patch });
  const errors = problems.filter(p => p.level === 'error');
  const warnings = problems.filter(p => p.level === 'warning');
  const help = existing?.status === 'REJECTED' ? rejectionHelp(existing.rejectedReason) : null;

  const setFormat = (format: TemplateDraft['format']) => {
    if (format === draft.format) return;
    if (draft.format === 'standard') stash.current = { header: draft.header, footer: draft.footer, buttons: draft.buttons };
    if (format === 'carousel') {
      set({
        format,
        header: { type: 'none', text: '', mediaId: null },
        footer: '',
        buttons: [],
        cards: draft.cards.length >= 2 ? draft.cards : [0, 1].map(() => ({ mediaId: null, body: '', buttons: [{ type: 'url' as const, text: 'Buy now', url: '', mode: 'static' as const, example: '' }] })),
      });
    } else if (format === 'offer') {
      set({
        format,
        header: ['image', 'video'].includes(draft.header.type) ? draft.header : { type: 'image', text: '', mediaId: null },
        footer: '',
        buttons: [
          { type: 'copy_code', example: (draft.buttons.find(b => b.type === 'copy_code') as { example?: string } | undefined)?.example ?? '' },
          draft.buttons.find(b => b.type === 'url') ?? newButton('url'),
        ],
      });
    } else if (stash.current) {
      set({ format, ...stash.current });
    } else {
      set({ format, buttons: draft.format === 'offer' ? draft.buttons.filter(b => b.type !== 'copy_code').concat([{ type: 'quick_reply', text: 'Stop promotions' }]) : draft.buttons });
    }
  };

  const save = async (submit: boolean) => {
    setBusy(submit ? 'submit' : 'draft');
    try {
      const body = { draft, submit };
      const saved = editingId ? await put<MetaTemplate>(`${base}/${editingId}`, body) : await post<MetaTemplate>(base, body);
      if (submit) {
        toast.success(saved.status === 'APPROVED' ? 'Approved by Meta: ready to use' : 'Sent to Meta for review. The status updates here by itself, usually within minutes.');
        navigate(back);
      } else {
        toast.success('Draft saved');
        setExisting(saved);
        if (!editingId) navigate(`/templates/meta/${encodeURIComponent(number)}/${saved.id}`, { replace: true });
      }
    } catch (err) {
      const details = err instanceof ApiError ? (err.details as { problems?: TemplateProblem[] } | undefined) : undefined;
      if (details?.problems) setProblems(details.problems);
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // Carousel buttons: the same kinds on every card, each card with its own text and link.
  const cardKinds = draft.cards[0]?.buttons.map(b => b.type) ?? [];
  const addCardButton = (type: 'quick_reply' | 'url' | 'phone') =>
    set({ cards: draft.cards.map(c => ({ ...c, buttons: [...c.buttons, newButton(type) as Exclude<DraftButton, { type: 'copy_code' }>] })) });
  const removeCardButton = (index: number) => set({ cards: draft.cards.map(c => ({ ...c, buttons: c.buttons.filter((_b, i) => i !== index) })) });

  const title = editingId
    ? existing?.status === 'DRAFT'
      ? `Draft: ${draft.name || 'new template'}`
      : `Edit ${existing?.name ?? 'template'}`
    : as === 'language' && source
      ? `Add a language to ${source.name}`
      : 'Create a WhatsApp template';

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <PageHeader
        back={
          <Link to={back} className="row small">
            <IconArrowLeft size={14} /> Templates
          </Link>
        }
        title={title}
        description="Build the message, check it against Meta’s rules, and send it for approval. Approved templates can start conversations from your official number."
        actions={existing && existing.status !== 'DRAFT' ? <StatusBadges template={existing} /> : undefined}
      />
      {help && (
        <Callout tone="danger">
          <strong>Rejected: {help.why}</strong> {existing?.statusNote ? `${existing.statusNote} ` : ''}
          {help.fix}
        </Callout>
      )}
      {inMeta && existing && existing.status !== 'REJECTED' && (
        <Callout>
          {templateStatus(existing.status).meaning} Changes go to Meta for review again.{' '}
          {existing.status === 'APPROVED' ? 'Meta allows changing an approved template once a day (10 times a month), and its category stays the same.' : ''}
        </Callout>
      )}
      {!editingId && !from && (
        <div className="row wrap" style={{ gap: 6, margin: '4px 0 12px' }}>
          <span className="small secondary">Start from an example:</span>
          {STARTERS.map(s => (
            <Button key={s.label} size="sm" onClick={() => setDraft({ ...BLANK_DRAFT, ...s.draft, samples: {} })}>
              {s.label}
            </Button>
          ))}
        </div>
      )}
      <div className="tpl-builder">
        <div className="stack">
          <Section title="1. Name, language and type">
            <div className="grid cols-2">
              <Field label="Template name" hint={inMeta ? 'Meta keeps the name. Duplicate the template to use another.' : 'Small letters, numbers and _ only. Customers don’t see it.'}>
                <input className="input mono" value={draft.name} disabled={inMeta || as === 'language'} placeholder="e.g. diwali_offer_2026" onChange={e => set({ name: slug(e.target.value) })} />
              </Field>
              <Field label="Language" hint={as === 'language' ? 'Choose the new language and write the message in it.' : 'The language the message is written in.'}>
                <select className="select" value={draft.language} disabled={inMeta} onChange={e => set({ language: e.target.value })}>
                  {!draft.language && <option value="">Choose a language…</option>}
                  {options.languages.map(l => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Issues problems={problems} field="name" />
            <Issues problems={problems} field="language" />
            <span className="label">Category</span>
            <div className="grid cols-2">
              {(
                [
                  ['MARKETING', 'Marketing', 'Offers, new arrivals, festival greetings, invitations, newsletters.'],
                  ['UTILITY', 'Utility', 'Updates about something the customer did: order shipped, booking confirmed, payment received.'],
                ] as const
              ).map(([value, name, text]) => (
                <label key={value} className={`option-card ${draft.category === value ? 'selected' : ''} ${lockedCategory ? 'disabled' : ''}`}>
                  <input
                    type="radio"
                    checked={draft.category === value}
                    disabled={lockedCategory}
                    onChange={() => set({ category: value, ...(value === 'UTILITY' && draft.format !== 'standard' ? { format: 'standard' as const, cards: [], buttons: draft.buttons.filter(b => b.type !== 'copy_code') } : {}) })}
                  />
                  <span>
                    <strong>{name}</strong>
                    <br />
                    <span className="small muted">{text}</span>
                  </span>
                </label>
              ))}
            </div>
            <Issues problems={problems} field="category" />
            {marketing && (
              <>
                <span className="label">Type</span>
                <Segmented
                  value={draft.format}
                  onChange={setFormat}
                  options={[
                    { value: 'standard', label: 'Standard message' },
                    { value: 'carousel', label: 'Carousel (2–10 cards)' },
                    { value: 'offer', label: 'Limited-time offer' },
                  ]}
                />
                <span className="hint">
                  {draft.format === 'carousel'
                    ? 'A message with swipeable cards, each with its own photo or video, text and buttons. Great for showing several products.'
                    : draft.format === 'offer'
                      ? 'Shows an offer headline, a countdown to when it ends, and a button to copy the offer code. (Not shown on WhatsApp Web or desktop.)'
                      : 'Text with an optional header, footer and buttons.'}
                </span>
              </>
            )}
            <Issues problems={problems} field="format" />
          </Section>

          {draft.format !== 'carousel' && (
            <Section title="2. Header" subtitle="Optional. Shown at the top of the message.">
              <Segmented
                value={draft.header.type}
                onChange={type => set({ header: { ...draft.header, type } })}
                options={(draft.format === 'offer' ? (['none', 'image', 'video'] as const) : (['none', 'text', 'image', 'video', 'document', 'location'] as const)).map(t => ({
                  value: t,
                  label: { none: 'None', text: 'Text', image: 'Image', video: 'Video', document: 'Document', location: 'Location' }[t],
                }))}
              />
              {draft.header.type === 'text' && (
                <RichText singleLine value={draft.header.text} max={60} placeholder="e.g. Our Diwali sale is on!" onChange={text => set({ header: { ...draft.header, text } })} />
              )}
              {(draft.header.type === 'image' || draft.header.type === 'video' || draft.header.type === 'document') && (
                <div className="stack tight">
                  {draft.header.mediaId ? (
                    <AttachedMedia mediaId={draft.header.mediaId} onRemove={() => set({ header: { ...draft.header, mediaId: null } })} />
                  ) : (
                    <div>
                      <Button size="sm" onClick={() => setPicking('header')}>
                        Choose {draft.header.type === 'image' ? 'an image' : draft.header.type === 'video' ? 'a video' : 'a PDF'}
                      </Button>
                    </div>
                  )}
                  <span className="hint">
                    {draft.header.type === 'image' ? 'JPG or PNG, up to 5 MB.' : draft.header.type === 'video' ? 'MP4, up to 16 MB.' : 'PDF, up to 100 MB.'} Meta reviews this example; each campaign can send a
                    different one.
                  </span>
                </div>
              )}
              {draft.header.type === 'location' && <span className="hint">A map pin at the top. Each campaign chooses the place (your shop, a delivery address…).</span>}
              <Issues problems={problems} field="header" />
            </Section>
          )}

          {draft.format === 'offer' && (
            <Section title="Offer">
              <Field label="Offer headline" hint="Up to 16 characters, e.g. “Diwali deal”.">
                <input className="input" value={draft.offer.text} maxLength={30} onChange={e => set({ offer: { ...draft.offer, text: e.target.value } })} />
              </Field>
              <Toggle
                checked={draft.offer.expires}
                onChange={expires => set({ offer: { ...draft.offer, expires } })}
                label="Show a countdown to when the offer ends"
                description="Each campaign sets the end date and time."
              />
              <Issues problems={problems} field="offer" />
            </Section>
          )}

          <Section title={`${draft.format === 'carousel' ? '2' : '3'}. Message`} subtitle="Use blanks for what changes per customer, like their name or an offer code.">
            <RichText
              value={draft.body}
              max={draft.format === 'offer' ? 600 : 1024}
              rows={7}
              placeholder={'Hi {{first_name}}, our new collection is here! …'}
              onChange={body => set({ body })}
            />
            <Issues problems={problems} field="body" />
            {names.length > 0 && (
              <div className="stack tight">
                <span className="label">Examples for the blanks</span>
                <span className="hint">Meta needs an example of each to review the template. Campaigns fill in the real values (e.g. each customer’s name).</span>
                <div className="grid cols-2">
                  {names.map(name => (
                    <Field key={name} label={`{{${name}}} · ${label(name)}`}>
                      <input className="input sm" value={draft.samples[name] ?? ''} onChange={e => set({ samples: { ...draft.samples, [name]: e.target.value } })} />
                    </Field>
                  ))}
                </div>
                <Issues problems={problems} field="samples" />
              </div>
            )}
          </Section>

          {draft.format === 'standard' && (
            <Section title="4. Footer" subtitle="Optional small grey text under the message.">
              <div className="row" style={{ gap: 8 }}>
                <input className="input" value={draft.footer} maxLength={80} placeholder="e.g. Your shop name" onChange={e => set({ footer: e.target.value })} />
                <span className={`small ${draft.footer.length > 60 ? 'error-text' : 'muted'}`}>{draft.footer.length}/60</span>
              </div>
              {marketing && !draft.footer && (
                <div>
                  <Button size="sm" onClick={() => set({ footer: 'Not interested? Tap Stop promotions' })}>
                    Use “Not interested? Tap Stop promotions”
                  </Button>
                </div>
              )}
              <Issues problems={problems} field="footer" />
            </Section>
          )}

          {draft.format !== 'carousel' && (
            <Section title={`${draft.format === 'offer' ? '4' : '5'}. Buttons`} subtitle={draft.format === 'offer' ? 'A limited-time offer has a copy-code button and a website button.' : 'Optional, up to 10.'}>
              {draft.buttons.map((button, i) => (
                <ButtonRow
                  key={i}
                  button={button}
                  fixed={draft.format === 'offer'}
                  trackingPrefix={options.trackingPrefix}
                  onChange={b => set({ buttons: draft.buttons.map((x, j) => (j === i ? b : x)) })}
                  onRemove={() => set({ buttons: draft.buttons.filter((_x, j) => j !== i) })}
                  onMove={by => {
                    const next = [...draft.buttons];
                    const j = i + by;
                    if (j < 0 || j >= next.length) return;
                    [next[i], next[j]] = [next[j], next[i]];
                    set({ buttons: next });
                  }}
                />
              ))}
              {draft.format === 'standard' && draft.buttons.length < 10 && (
                <div className="row wrap" style={{ gap: 6 }}>
                  {marketing && !draft.buttons.some(b => b.type === 'quick_reply' && /^stop promotions?$/i.test(b.text)) && (
                    <Button size="sm" icon={<IconPlus size={14} />} onClick={() => set({ buttons: [...draft.buttons, { type: 'quick_reply', text: 'Stop promotions' }] })}>
                      Unsubscribe button
                    </Button>
                  )}
                  <Button size="sm" icon={<IconPlus size={14} />} onClick={() => set({ buttons: [...draft.buttons, newButton('quick_reply')] })}>
                    Quick reply
                  </Button>
                  {draft.buttons.filter(b => b.type === 'url').length < 2 && (
                    <Button size="sm" icon={<IconPlus size={14} />} onClick={() => set({ buttons: [...draft.buttons, newButton('url')] })}>
                      Website link
                    </Button>
                  )}
                  {!draft.buttons.some(b => b.type === 'phone') && (
                    <Button size="sm" icon={<IconPlus size={14} />} onClick={() => set({ buttons: [...draft.buttons, newButton('phone')] })}>
                      Call button
                    </Button>
                  )}
                  {marketing && !draft.buttons.some(b => b.type === 'copy_code') && (
                    <Button size="sm" icon={<IconPlus size={14} />} onClick={() => set({ buttons: [...draft.buttons, newButton('copy_code')] })}>
                      Copy offer code
                    </Button>
                  )}
                </div>
              )}
              <span className="hint">Quick replies send their text back to you when tapped. “Stop promotions” unsubscribes the customer automatically.</span>
              <Issues problems={problems} field="buttons" />
            </Section>
          )}

          {draft.format === 'carousel' && (
            <Section title="3. Cards" subtitle="2 to 10 cards. Every card has a photo or video, and the same kinds of buttons.">
              <div className="row wrap" style={{ gap: 10 }}>
                <span className="label" style={{ margin: 0 }}>
                  Each card has
                </span>
                <Segmented value={draft.cardFormat} onChange={cardFormat => set({ cardFormat, cards: draft.cards.map(c => ({ ...c, mediaId: null })) })} options={[{ value: 'image', label: 'an image' }, { value: 'video', label: 'a video' }]} />
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="small secondary">Buttons on every card:</span>
                {cardKinds.map((kind, i) => (
                  <Badge key={i}>
                    {BUTTON_KINDS[kind]}{' '}
                    <button type="button" className="link-button" aria-label={`Remove ${BUTTON_KINDS[kind]} from every card`} onClick={() => removeCardButton(i)}>
                      ×
                    </button>
                  </Badge>
                ))}
                {cardKinds.length < 2 && (
                  <>
                    <Button size="sm" onClick={() => addCardButton('url')}>
                      + Website link
                    </Button>
                    <Button size="sm" onClick={() => addCardButton('quick_reply')}>
                      + Quick reply
                    </Button>
                    {!cardKinds.includes('phone') && (
                      <Button size="sm" onClick={() => addCardButton('phone')}>
                        + Call
                      </Button>
                    )}
                  </>
                )}
              </div>
              {draft.cards.map((card, i) => (
                <div key={i} className="tpl-card-editor">
                  <div className="row between">
                    <strong>Card {i + 1}</strong>
                    {draft.cards.length > 2 && (
                      <button type="button" className="btn ghost icon sm" aria-label={`Remove card ${i + 1}`} onClick={() => set({ cards: draft.cards.filter((_c, j) => j !== i) })}>
                        <IconTrash size={14} />
                      </button>
                    )}
                  </div>
                  {card.mediaId ? (
                    <AttachedMedia mediaId={card.mediaId} onRemove={() => set({ cards: draft.cards.map((c, j) => (j === i ? { ...c, mediaId: null } : c)) })} />
                  ) : (
                    <div>
                      <Button size="sm" onClick={() => setPicking(i)}>
                        Choose {draft.cardFormat === 'image' ? 'an image' : 'a video'}
                      </Button>
                    </div>
                  )}
                  <Issues problems={problems} field={`cards.${i}.media`} />
                  <RichText value={card.body} max={160} rows={2} placeholder="Short text, e.g. Now only {{price}}" onChange={body => set({ cards: draft.cards.map((c, j) => (j === i ? { ...c, body } : c)) })} />
                  <Issues problems={problems} field={`cards.${i}.body`} />
                  {card.buttons.map((button, b) => (
                    <ButtonRow
                      key={b}
                      button={button}
                      fixed
                      trackingPrefix={options.trackingPrefix}
                      onChange={next => set({ cards: draft.cards.map((c, j) => (j === i ? { ...c, buttons: c.buttons.map((x, k) => (k === b ? (next as typeof x) : x)) } : c)) })}
                    />
                  ))}
                  <Issues problems={problems} field={`cards.${i}.buttons`} />
                </div>
              ))}
              {draft.cards.length < 10 && (
                <div>
                  <Button
                    size="sm"
                    icon={<IconPlus size={14} />}
                    onClick={() =>
                      set({
                        cards: [
                          ...draft.cards,
                          { mediaId: null, body: draft.cards[0]?.body ?? '', buttons: (draft.cards[0]?.buttons ?? []).map(b => ({ ...b, ...(b.type === 'url' ? { url: '' } : {}) })) },
                        ],
                      })
                    }
                  >
                    Add a card
                  </Button>
                </div>
              )}
              <Issues problems={problems} field="cards" exact />
            </Section>
          )}
        </div>

        <aside className="tpl-side">
          <Card title="Preview" subtitle="With the examples filled in">
            <TemplatePreview model={previewOfDraft(draft)} />
          </Card>
          <Card title="Before you submit">
            {checking && !problems.length ? (
              <span className="small muted">Checking…</span>
            ) : errors.length === 0 && warnings.length === 0 ? (
              <p className="row small" style={{ margin: 0, color: 'var(--brand-text)' }}>
                <IconCheck size={16} /> Looks good: no problems found.
              </p>
            ) : (
              <ul className="tpl-issues">
                {errors.map((p, i) => (
                  <li key={`e${i}`} className="error">
                    <IconAlert size={13} /> {p.message}
                  </li>
                ))}
                {warnings.map((p, i) => (
                  <li key={`w${i}`} className="warning">
                    <IconAlert size={13} /> {p.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="stack tight" style={{ marginTop: 14 }}>
              <Button variant="primary" loading={busy === 'submit'} disabled={!!busy || errors.length > 0} onClick={() => void save(true)}>
                {inMeta ? 'Submit changes for review' : 'Submit for review'}
              </Button>
              {!inMeta && (
                <Button loading={busy === 'draft'} disabled={!!busy || !draft.name} onClick={() => void save(false)}>
                  Save draft
                </Button>
              )}
              <span className="hint">Meta usually decides within minutes (at most 24 hours). The status shows on the Templates page and updates by itself.</span>
            </div>
          </Card>
        </aside>
      </div>
      {picking !== null && (
        <MediaPicker
          selectedId={picking === 'header' ? draft.header.mediaId : draft.cards[picking]?.mediaId}
          onClose={() => setPicking(null)}
          onPick={media => {
            if (picking === 'header') set({ header: { ...draft.header, mediaId: media.id } });
            else set({ cards: draft.cards.map((c, j) => (j === picking ? { ...c, mediaId: media.id } : c)) });
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
