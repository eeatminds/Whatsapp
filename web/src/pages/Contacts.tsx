import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  del,
  patch,
  post,
  useApi,
  errorMessage,
  type Contact,
  type ContactFilter,
  type Consent,
  type Message,
  type Paged,
  type Segment,
  type Sequence,
} from '../api';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConsentBadge,
  Drawer,
  Empty,
  ErrorNote,
  Field,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  TagChip,
  Toggle,
  WaBadge,
  useConfirm,
  useToast,
} from '../components/ui';
import { IconDownload, IconPlus, IconSearch, IconUpload } from '../components/icons';
import { TagPicker, useTags } from '../components/pickers';
import { Bubble } from '../components/composer';
import { displayName, formatDateTime, formatNumber, formatPhone, relativeTime } from '../format';

const AUDIENCE_HANDOFF = 'wa-reach:audience';

function toQuery(filter: ContactFilter, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filter, ...extra })) if (v !== undefined && v !== '' && !Array.isArray(v)) params.set(k, String(v));
  return params.toString();
}

// ---------------------------------------------------------------- import wizard

/**
 * A ready-to-fill spreadsheet. Phone numbers are written with spaces so Excel keeps them as text
 * (a bare 919876543210 turns into 9.19E+11 and loses digits; a leading + is read as a formula).
 */
const TEMPLATE_CSV = [
  'Phone,Name,Email,Tags,City',
  '98765 43210,Priya Sharma,priya@example.com,"customer, vip",Bengaluru',
  '0091 91234 56789,Rahul Verma,,new-lead,Pune',
].join('\r\n');

export function downloadContactsTemplate() {
  // The byte-order mark makes Excel open the file as UTF-8 (names with accents, ₹, Hindi, etc.).
  const blob = new Blob(['\uFEFF' + TEMPLATE_CSV + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'contacts-template.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const FIELD_LABELS: Record<string, string> = {
  phone: 'Phone',
  name: 'Name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  tags: 'Tags',
};

type Mapping = Record<string, string>;

const FIELD_OPTIONS = [
  { value: 'phone', label: 'Phone (required)' },
  { value: 'name', label: 'Full name' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'email', label: 'Email' },
  { value: 'tags', label: 'Tags (comma separated)' },
  { value: 'ignore', label: "Don't import" },
];

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<{ headers: string[]; rows: string[][]; totalRows: number; mapping: Mapping } | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [consent, setConsent] = useState<'unknown' | 'opted_in'>('unknown');
  const [consentSource, setConsentSource] = useState('');
  const [updateExisting, setUpdateExisting] = useState(true);
  const [result, setResult] = useState<{ total: number; created: number; updated: number; unchanged: number; skipped: number; errors: Array<{ row: number; value: string; reason: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = async (text: string, name: string) => {
    setError(null);
    setBusy(true);
    try {
      const p = await post<typeof preview & object>('/api/contacts/import/preview', { csv: text });
      setCsv(text);
      setFileName(name);
      setPreview(p);
      setMapping(p.mapping);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const phoneMapped = Object.values(mapping).filter(v => v === 'phone').length === 1;
  const [showMapping, setShowMapping] = useState(false);

  const runImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<NonNullable<typeof result>>('/api/contacts/import', {
        csv,
        mapping,
        tagIds,
        consent,
        consentSource: consent === 'opted_in' ? consentSource || undefined : undefined,
        updateExisting,
      });
      setResult(r);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import contacts"
      wide
      onClose={onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            {preview && (
              <Button variant="primary" loading={busy} disabled={!phoneMapped || (consent === 'opted_in' && !consentSource.trim())} onClick={runImport}>
                Import {formatNumber(preview.totalRows)} rows
              </Button>
            )}
          </>
        )
      }
    >
      <ErrorNote error={error} />
      {result ? (
        <div className="stack">
          <Callout tone="success">
            {formatNumber(result.created)} added, {formatNumber(result.updated)} updated, {formatNumber(result.unchanged)} unchanged, {formatNumber(result.skipped)} skipped.
          </Callout>
          {result.errors.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Value</th>
                    <th>Why it was skipped</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map(e => (
                    <tr key={e.row}>
                      <td className="num">{e.row}</td>
                      <td className="mono">{e.value || '(empty)'}</td>
                      <td>{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : !preview ? (
        <div className="stack">
          <ol className="stack tight" style={{ margin: 0, paddingLeft: 20 }}>
            <li>
              <Button size="sm" icon={<IconDownload size={14} />} onClick={downloadContactsTemplate}>
                Download the template
              </Button>{' '}
              <span className="secondary">and open it in Excel or Google Sheets.</span>
            </li>
            <li className="secondary">
              Fill one person per row. Only <strong>Phone</strong> is required. Type mobile numbers with a space, like <span className="mono">98765 43210</span>. For
              another country, start with 00 and its code, like <span className="mono">00971 50 123 4567</span>.
              Put several tags in one cell separated by commas. Rename or add columns (e.g. City) for your own fields.
            </li>
            <li className="secondary">
              Save as <strong>CSV</strong> (Excel: File → Save As → CSV UTF-8. Sheets: File → Download → CSV) and upload it below.
            </li>
          </ol>
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv,text/plain"
            hidden
            onChange={async e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) await load(await file.text(), file.name);
            }}
          />
          <div
            className="empty"
            style={{ border: '2px dashed var(--border-strong)', borderRadius: 10, cursor: 'pointer' }}
            onClick={() => input.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={async e => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) await load(await file.text(), file.name);
            }}
          >
            <IconUpload size={28} />
            <h3 style={{ marginTop: 8 }}>Drop a CSV here or click to choose</h3>
            <p className="small">Comma, semicolon and tab separated files all work. Up to 100,000 rows.</p>
          </div>
        </div>
      ) : (
        <div className="stack loose">
          <div className="row between">
            <span>
              <strong>{fileName}</strong> <span className="muted">· {formatNumber(preview.totalRows)} rows</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Choose another file
            </Button>
          </div>
          {preview && (
            <div className="stack tight">
              <span className="label">We'll import</span>
              <div className="row wrap" style={{ gap: 6 }}>
                {preview.headers.map((header, i) => {
                  const value = mapping[String(i)] ?? 'ignore';
                  if (value === 'ignore') return null;
                  const target = value.startsWith('attr:') ? `custom field "${value.slice(5)}"` : FIELD_LABELS[value] ?? value;
                  return (
                    <span key={i} className="badge">
                      {header || `Column ${i + 1}`}
                      {(header || '').trim().toLowerCase() !== target.toLowerCase() ? ` → ${target}` : ''}
                    </span>
                  );
                })}
              </div>
              {preview.headers.some((_, i) => (mapping[String(i)] ?? 'ignore') === 'ignore') && (
                <span className="small muted">
                  Skipped: {preview.headers.filter((_, i) => (mapping[String(i)] ?? 'ignore') === 'ignore').map((h, i) => h || `Column ${i + 1}`).join(', ')}
                </span>
              )}
              <div>
                <Button size="sm" variant="ghost" onClick={() => setShowMapping(!showMapping)}>
                  {showMapping || !phoneMapped ? 'Hide column matching' : 'Change which columns are imported'}
                </Button>
              </div>
            </div>
          )}
          {(showMapping || !phoneMapped) && (
          <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Import as</th>
                    <th>Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.headers.map((header, i) => {
                    const value = mapping[String(i)] ?? 'ignore';
                    const isAttr = value.startsWith('attr:');
                    return (
                      <tr key={i}>
                        <td>
                          <strong>{header || `Column ${i + 1}`}</strong>
                        </td>
                        <td style={{ minWidth: 220 }}>
                          <select className="select sm" value={isAttr ? 'attr' : value} onChange={e => setMapping({ ...mapping, [i]: e.target.value === 'attr' ? `attr:${(header || `column_${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}` : e.target.value })}>
                            {FIELD_OPTIONS.map(o => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                            <option value="attr">Custom field{isAttr ? `: ${value.slice(5)}` : ''}</option>
                          </select>
                        </td>
                        <td className="secondary small">{preview.rows.map(r => r[i]).filter(Boolean).slice(0, 3).join(' · ')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!phoneMapped && <Callout tone="warn">Map exactly one column to Phone.</Callout>}
          <div className="grid cols-2">
            <Field label="Tag everyone in this import" hint="Useful for targeting this list later, e.g. expo-2026.">
              <TagPicker value={tagIds} onChange={setTagIds} />
            </Field>
            <div className="stack">
              <span className="label">Consent</span>
              <label className={`option-card ${consent === 'unknown' ? 'selected' : ''}`}>
                <input type="radio" checked={consent === 'unknown'} onChange={() => setConsent('unknown')} />
                <span>
                  <strong>Not recorded</strong>
                  <br />
                  <span className="small secondary">They can receive campaigns that don't require opt-in.</span>
                </span>
              </label>
              <label className={`option-card ${consent === 'opted_in' ? 'selected' : ''}`}>
                <input type="radio" checked={consent === 'opted_in'} onChange={() => setConsent('opted_in')} />
                <span>
                  <strong>These people opted in to WhatsApp messages</strong>
                  <br />
                  <span className="small secondary">Existing opt-outs are never overwritten.</span>
                </span>
              </label>
              {consent === 'opted_in' && (
                <Field label="Where did they opt in?" hint="Kept as the consent record, e.g. 'Checkout checkbox, Sept 2026'.">
                  <input className="input" value={consentSource} onChange={e => setConsentSource(e.target.value)} />
                </Field>
              )}
            </div>
          </div>
          <Toggle checked={updateExisting} onChange={setUpdateExisting} label="Update existing contacts" description="Fill in names, emails and custom fields for numbers already in your list." />
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- contact drawer

function ContactDrawer({ contactId, onClose, onChanged }: { contactId: number | 'new'; onClose: () => void; onChanged: () => void }) {
  const isNew = contactId === 'new';
  const { data, loading } = useApi<{
    contact: Contact;
    messages: Message[];
    campaigns: Array<{ campaignId: number; name: string; status: string; sentAt: string | null; readAt: string | null; repliedAt: string | null; clickedAt: string | null }>;
    sequences: Array<{ id: number; name: string; status: string; current_step: number }>;
  }>(isNew ? null : `/api/contacts/${contactId}`);
  const [form, setForm] = useState({ phone: '', name: '', email: '', consent: 'unknown' as Consent, tagIds: [] as number[], attributes: [] as Array<[string, string]> });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    if (!data) return;
    const c = data.contact;
    setForm({ phone: `+${c.phone}`, name: c.name ?? '', email: c.email ?? '', consent: c.consent, tagIds: c.tags.map(t => t.id), attributes: Object.entries(c.attributes) });
  }, [data]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const attributes = Object.fromEntries(form.attributes.filter(([k]) => k.trim()));
    try {
      if (isNew) {
        await post('/api/contacts', { phone: form.phone, name: form.name || null, email: form.email || null, consent: form.consent === 'unknown' ? undefined : form.consent, tagIds: form.tagIds, attributes, consentSource: 'manual' });
      } else {
        await patch(`/api/contacts/${contactId}`, { phone: form.phone, name: form.name || null, email: form.email || null, consent: form.consent, tagIds: form.tagIds, attributes });
      }
      toast.success(isNew ? 'Contact added' : 'Contact saved');
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const contact = data?.contact;
  return (
    <Drawer
      title={isNew ? 'Add contact' : contact ? displayName(contact) : 'Contact'}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <Button
              variant="danger"
              onClick={async () => {
                if (await confirm('Delete contact?', 'Their message history and campaign results are removed too.', { confirmLabel: 'Delete', danger: true })) {
                  await del(`/api/contacts/${contactId}`);
                  onChanged();
                  onClose();
                }
              }}
            >
              Delete
            </Button>
          )}
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!form.phone.trim()}>
            {isNew ? 'Add contact' : 'Save'}
          </Button>
        </>
      }
    >
      {loading && !data ? (
        <Loading />
      ) : (
        <>
          <ErrorNote error={error} />
          {contact && (
            <div className="row wrap">
              <ConsentBadge consent={contact.consent} />
              <WaBadge status={contact.waStatus} pending={contact.waCheckPending} />
              {contact.source && <Badge>Source: {contact.source}</Badge>}
              <span className="spacer" />
              <Button size="sm" onClick={() => navigate(`/inbox/${contact.id}`)}>
                Open chat
              </Button>
            </div>
          )}
          <div className="grid cols-2">
            <Field label="Phone">
              <input className="input" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+91 98765 43210" />
            </Field>
            <Field label="Name">
              <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Email">
              <input className="input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Consent" hint={contact?.consentSource ? `Recorded from ${contact.consentSource} ${relativeTime(contact.consentAt)}` : undefined}>
              <select className="select" value={form.consent} onChange={e => setForm({ ...form, consent: e.target.value as Consent })}>
                <option value="opted_in">Opted in</option>
                <option value="unknown">Not recorded</option>
                <option value="opted_out">Opted out</option>
              </select>
            </Field>
          </div>
          {contact?.consent === 'opted_out' && form.consent !== 'opted_out' && (
            <Callout tone="warn">This person opted out. Only re-subscribe them if they asked you to.</Callout>
          )}
          <Field label="Tags">
            <TagPicker value={form.tagIds} onChange={tagIds => setForm({ ...form, tagIds })} />
          </Field>
          <div className="stack tight">
            <span className="label">Custom fields</span>
            <span className="hint">Use them in messages as {'{{field_name}}'}.</span>
            {form.attributes.map(([key, value], i) => (
              <div className="row" key={i}>
                <input
                  className="input sm"
                  placeholder="field"
                  value={key}
                  onChange={e => setForm({ ...form, attributes: form.attributes.map((a, j) => (j === i ? [e.target.value, a[1]] : a)) })}
                />
                <input
                  className="input sm"
                  placeholder="value"
                  value={value}
                  onChange={e => setForm({ ...form, attributes: form.attributes.map((a, j) => (j === i ? [a[0], e.target.value] : a)) })}
                />
                <Button size="sm" variant="ghost" aria-label="Remove field" onClick={() => setForm({ ...form, attributes: form.attributes.filter((_, j) => j !== i) })}>
                  ×
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm" icon={<IconPlus size={14} />} onClick={() => setForm({ ...form, attributes: [...form.attributes, ['', '']] })}>
                Add field
              </Button>
            </div>
          </div>
          {data && (
            <>
              <div className="divider" />
              <div className="stack tight">
                <h3>Campaigns</h3>
                {data.campaigns.length === 0 ? (
                  <p className="muted small">Not in any campaign yet.</p>
                ) : (
                  data.campaigns.map(c => (
                    <div key={c.campaignId} className="row between small">
                      <a href={`/campaigns/${c.campaignId}`} onClick={e => (e.preventDefault(), navigate(`/campaigns/${c.campaignId}`))}>
                        {c.name}
                      </a>
                      <span className="secondary">{c.repliedAt ? 'Replied' : c.clickedAt ? 'Clicked' : c.readAt ? 'Read' : c.status}</span>
                    </div>
                  ))
                )}
              </div>
              {data.sequences.length > 0 && (
                <div className="stack tight">
                  <h3>Drip sequences</h3>
                  {data.sequences.map(s => (
                    <div key={s.id} className="row between small">
                      <span>{s.name}</span>
                      <span className="secondary">
                        {s.status} · step {s.current_step + (s.status === 'completed' ? 0 : 1)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="stack tight">
                <h3>Recent messages</h3>
                {data.messages.length === 0 ? (
                  <p className="muted small">No messages yet.</p>
                ) : (
                  <div className="wa-preview" style={{ maxHeight: 320, overflowY: 'auto' }}>
                    {data.messages.slice(-12).map(m => (
                      <Bubble key={m.id} text={m.body ?? (m.type !== 'text' ? `[${m.type}]` : '')} mediaId={m.mediaId} direction={m.direction} time={formatDateTime(m.createdAt)} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
      {dialog}
    </Drawer>
  );
}

// ---------------------------------------------------------------- page

function BulkModal({ kind, count, filter, onClose, onDone }: { kind: 'add_tags' | 'remove_tags' | 'set_consent' | 'enroll'; count: number; filter: ContactFilter; onClose: () => void; onDone: () => void }) {
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [consent, setConsent] = useState<Consent>('opted_in');
  const [sequenceId, setSequenceId] = useState<number | ''>('');
  const { data: sequences } = useApi<Sequence[]>(kind === 'enroll' ? '/api/sequences' : null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const titles = { add_tags: 'Add tags', remove_tags: 'Remove tags', set_consent: 'Set consent', enroll: 'Enroll in drip sequence' };
  const run = async () => {
    setBusy(true);
    try {
      if (kind === 'enroll') {
        const r = await post<{ enrolled: number; skipped: number }>(`/api/sequences/${sequenceId}/enroll`, { filter });
        toast.success(`${r.enrolled} enrolled${r.skipped ? `, ${r.skipped} skipped (opted out or already enrolled)` : ''}`);
      } else {
        const r = await post<{ affected: number }>('/api/contacts/bulk', { filter, action: kind, tagIds, consent });
        toast.success(`${formatNumber(r.affected)} updated`);
      }
      onDone();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${titles[kind]} · ${formatNumber(count)} contacts`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={run} disabled={(kind.endsWith('tags') && tagIds.length === 0) || (kind === 'enroll' && !sequenceId)}>
            Apply
          </Button>
        </>
      }
    >
      {kind.endsWith('tags') && <TagPicker value={tagIds} onChange={setTagIds} allowCreate={kind === 'add_tags'} />}
      {kind === 'set_consent' && (
        <>
          <select className="select" value={consent} onChange={e => setConsent(e.target.value as Consent)}>
            <option value="opted_in">Opted in</option>
            <option value="unknown">Not recorded</option>
            <option value="opted_out">Opted out</option>
          </select>
          <p className="hint">Contacts who opted out themselves are never re-subscribed by a bulk change.</p>
        </>
      )}
      {kind === 'enroll' && (
        <select className="select" value={sequenceId} onChange={e => setSequenceId(Number(e.target.value) || '')}>
          <option value="">Choose a sequence…</option>
          {sequences?.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
    </Modal>
  );
}

export function ContactsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ContactFilter>({});
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [open, setOpen] = useState<number | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [bulk, setBulk] = useState<'add_tags' | 'remove_tags' | 'set_consent' | 'enroll' | null>(null);
  const { data: tags } = useTags();
  const { data: segments } = useApi<Segment[]>('/api/segments');

  useEffect(() => {
    const timer = setTimeout(() => setSearch(q), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const activeFilter = useMemo<ContactFilter>(() => ({ ...filter, q: search || undefined }), [filter, search]);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setAllMatching(false);
  }, [activeFilter]);

  const { data, error, loading, reload } = useApi<Paged<Contact>>(`/api/contacts?${toQuery(activeFilter, { page, pageSize: 50 })}`);
  const items = data?.items ?? [];
  const allOnPage = items.length > 0 && items.every(c => selected.has(c.id));
  const selectionCount = allMatching ? (data?.total ?? 0) : selected.size;
  const selectionFilter: ContactFilter = allMatching ? activeFilter : { ids: [...selected] };
  const hasFilters = Object.values(activeFilter).some(v => v !== undefined);

  const runBulk = async (action: 'delete' | 'validate') => {
    try {
      const r = await post<{ affected: number }>('/api/contacts/bulk', { filter: selectionFilter, action });
      toast.success(action === 'delete' ? `${formatNumber(r.affected)} deleted` : `${formatNumber(r.affected)} queued for a WhatsApp check`);
      setSelected(new Set());
      setAllMatching(false);
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Contacts"
        description="Your WhatsApp audience, with consent and engagement for every number."
        actions={
          <>
            <Button icon={<IconDownload size={16} />} onClick={() => (window.location.href = `/api/contacts/export.csv?${toQuery(activeFilter)}`)}>
              Export
            </Button>
            <Button icon={<IconDownload size={16} />} onClick={downloadContactsTemplate}>
              Download template
            </Button>
            <Button icon={<IconUpload size={16} />} onClick={() => setImporting(true)}>
              Import CSV
            </Button>
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setOpen('new')}>
              Add contact
            </Button>
          </>
        }
      />
      <Card bodyClass="">
        <div className="card-header" style={{ flexWrap: 'wrap' }}>
          <div className="row wrap" style={{ flex: 1 }}>
            <div className="row" style={{ position: 'relative', minWidth: 220, flex: '1 1 220px', maxWidth: 320 }}>
              <IconSearch size={16} style={{ position: 'absolute', left: 10, color: 'var(--text-muted)' }} />
              <input className="input sm" style={{ paddingLeft: 32 }} placeholder="Search name, phone, email" value={q} onChange={e => setQ(e.target.value)} aria-label="Search contacts" />
            </div>
            <select className="select sm" style={{ width: 'auto' }} value={filter.tagId ?? ''} onChange={e => setFilter({ ...filter, tagId: Number(e.target.value) || undefined })} aria-label="Filter by tag">
              <option value="">All tags</option>
              {tags?.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.count})
                </option>
              ))}
            </select>
            <select className="select sm" style={{ width: 'auto' }} value={filter.consent ?? ''} onChange={e => setFilter({ ...filter, consent: (e.target.value || undefined) as Consent | undefined })} aria-label="Filter by consent">
              <option value="">Any consent</option>
              <option value="opted_in">Opted in</option>
              <option value="unknown">Not recorded</option>
              <option value="opted_out">Opted out</option>
            </select>
            <select className="select sm" style={{ width: 'auto' }} value={filter.waStatus ?? ''} onChange={e => setFilter({ ...filter, waStatus: (e.target.value || undefined) as ContactFilter['waStatus'] })} aria-label="Filter by WhatsApp status">
              <option value="">Any WhatsApp status</option>
              <option value="valid">On WhatsApp</option>
              <option value="invalid">Not on WhatsApp</option>
              <option value="unknown">Unverified</option>
            </select>
            <select className="select sm" style={{ width: 'auto' }} value={filter.segmentId ?? ''} onChange={e => setFilter({ ...filter, segmentId: Number(e.target.value) || undefined })} aria-label="Filter by segment">
              <option value="">All segments</option>
              {segments?.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {hasFilters && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFilter({});
                  setQ('');
                }}
              >
                Clear
              </Button>
            )}
          </div>
          <span className="muted small">{data ? `${formatNumber(data.total)} contacts` : ''}</span>
        </div>
        {selectionCount > 0 && (
          <div className="card-header" style={{ background: 'var(--brand-soft)', flexWrap: 'wrap' }}>
            <div className="row wrap">
              <strong>{formatNumber(selectionCount)} selected</strong>
              {!allMatching && allOnPage && data && data.total > items.length && (
                <button type="button" className="link-button" onClick={() => setAllMatching(true)}>
                  Select all {formatNumber(data.total)} matching
                </button>
              )}
            </div>
            <div className="row wrap">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  sessionStorage.setItem(AUDIENCE_HANDOFF, JSON.stringify(allMatching ? { filter: activeFilter } : { contactIds: [...selected] }));
                  navigate('/campaigns/new?audience=selection');
                }}
              >
                Send campaign
              </Button>
              <Button size="sm" onClick={() => setBulk('add_tags')}>
                Add tags
              </Button>
              <Button size="sm" onClick={() => setBulk('remove_tags')}>
                Remove tags
              </Button>
              <Button size="sm" onClick={() => setBulk('set_consent')}>
                Consent
              </Button>
              <Button size="sm" onClick={() => setBulk('enroll')}>
                Enroll in sequence
              </Button>
              <Button size="sm" onClick={() => runBulk('validate')}>
                Check on WhatsApp
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (await confirm(`Delete ${formatNumber(selectionCount)} contacts?`, 'This cannot be undone.', { confirmLabel: 'Delete', danger: true })) await runBulk('delete');
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        )}
        <ErrorNote error={error} />
        {loading && !data ? (
          <Loading />
        ) : items.length === 0 ? (
          hasFilters ? (
            <Empty title="No contacts match these filters" />
          ) : (
            <Empty
              title="No contacts yet"
              action={
                <div className="row" style={{ justifyContent: 'center' }}>
                  <Button variant="primary" onClick={() => setImporting(true)}>
                    Import a CSV
                  </Button>
                  <Button onClick={() => setOpen('new')}>Add one contact</Button>
                </div>
              }
            >
              Import from a spreadsheet, add people one by one, or let them message your number: anyone who writes to you is added automatically.
            </Empty>
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="check-col">
                      <input
                        type="checkbox"
                        aria-label="Select all on this page"
                        checked={allOnPage}
                        onChange={e => {
                          setAllMatching(false);
                          setSelected(e.target.checked ? new Set(items.map(c => c.id)) : new Set());
                        }}
                      />
                    </th>
                    <th>Contact</th>
                    <th>Tags</th>
                    <th>Consent</th>
                    <th>WhatsApp</th>
                    <th>Last message in</th>
                    <th>Added</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(c => (
                    <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)}>
                      <td className="check-col" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${displayName(c)}`}
                          checked={allMatching || selected.has(c.id)}
                          onChange={e => {
                            setAllMatching(false);
                            const next = new Set(selected);
                            if (e.target.checked) next.add(c.id);
                            else next.delete(c.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td>
                        <div style={{ fontWeight: 550 }}>{c.name || <span className="muted">No name</span>}</div>
                        <div className="small secondary num">{formatPhone(c.phone)}</div>
                      </td>
                      <td>
                        <div className="row wrap" style={{ gap: 4 }}>
                          {c.tags.slice(0, 3).map(t => (
                            <TagChip key={t.id} tag={t} />
                          ))}
                          {c.tags.length > 3 && <span className="small muted">+{c.tags.length - 3}</span>}
                        </div>
                      </td>
                      <td>
                        <ConsentBadge consent={c.consent} />
                      </td>
                      <td>
                        <WaBadge status={c.waStatus} pending={c.waCheckPending} />
                      </td>
                      <td className="secondary small nowrap">{c.lastInboundAt ? relativeTime(c.lastInboundAt) : '–'}</td>
                      <td className="secondary small nowrap">{relativeTime(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
          </>
        )}
      </Card>

      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => void reload()} />}
      {open !== null && <ContactDrawer contactId={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />}
      {bulk && <BulkModal kind={bulk} count={selectionCount} filter={selectionFilter} onClose={() => setBulk(null)} onDone={() => void reload()} />}
      {dialog}
    </div>
  );
}

export { AUDIENCE_HANDOFF };
