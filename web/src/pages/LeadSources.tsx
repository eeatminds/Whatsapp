import { useState } from 'react';
import { del, patch, post, put, useApi, errorMessage, type Sequence } from '../api';
import { Badge, Button, Callout, Card, Empty, ErrorNote, Field, Loading, Modal, Segmented, Toggle, useConfirm, useToast } from '../components/ui';
import { IconPlus } from '../components/icons';
import { TagPicker } from '../components/pickers';
import { CopyField } from '../components/official';
import { formatPhone, relativeTime } from '../format';

type Kind = 'google_sheet' | 'website' | 'wix' | 'other';

interface LeadSource {
  id: number;
  name: string;
  kind: Kind;
  active: boolean;
  actions: { tagIds: number[]; sequenceId?: number | null; markOptedIn: boolean; notifyPhone?: string | null };
  thankYouUrl: string | null;
  url: string | null;
  fieldMap: Record<string, FieldTarget>;
  fieldsSeen: Array<{ key: string; as: FieldTarget }>;
  received: number;
  failed: number;
  lastReceivedAt: string | null;
  createdAt: string;
}

type FieldTarget = 'phone' | 'country_code' | 'name' | 'first_name' | 'last_name' | 'email' | 'custom' | 'ignore';

const TARGET_LABEL: Record<FieldTarget, string> = {
  phone: 'Phone number',
  country_code: 'Country code',
  name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  custom: 'Custom field',
  ignore: "Don't save",
};

const columnLabel = (key: string) => {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

interface ColumnInfo {
  samples: Record<string, string>;
  leads: number;
  missingName: number;
  missingEmail: number;
}

function ColumnsEditor({ source, info, onSaved }: { source: LeadSource; info?: ColumnInfo; onSaved: () => void }) {
  const toast = useToast();
  const [map, setMap] = useState<Record<string, FieldTarget>>(source.fieldMap);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(map) !== JSON.stringify(source.fieldMap);
  if (source.fieldsSeen.length === 0) {
    return <p className="secondary">The columns of your {KIND_LABEL[source.kind].toLowerCase()} show here after the first lead arrives, so you can check each one was understood.</p>;
  }
  const nameChosen = Object.values(map).some(t => t === 'name' || t === 'first_name');
  return (
    <div className="stack">
      {info && info.missingName > 0 && !nameChosen && (
        <Callout tone="warn">
          {info.missingName === info.leads ? 'Leads from here have no name.' : `${info.missingName} of ${info.leads} leads from here have no name.`} Your form sends coded
          column names (like “text-870”), so look at the examples below, set the column that holds the name to <strong>Full name</strong>, and save. Leads already received
          are fixed too.
        </Callout>
      )}
      <p className="secondary small">
        Each column we receive and what it is saved as. Most are recognised by their names; change any that are wrong. Custom fields show in Contacts, can be filtered
        on, and can go into messages, e.g. <code>{'{{city}}'}</code>.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Saved as</th>
            </tr>
          </thead>
          <tbody>
            {source.fieldsSeen.map(f => (
              <tr key={f.key}>
                <td>
                  {columnLabel(f.key)}
                  {info?.samples[f.key] && <div className="small secondary">e.g. “{info.samples[f.key]}”</div>}
                  {f.as === 'custom' && !map[f.key] && <div className="small muted">Custom field <code>{`{{${f.key}}}`}</code></div>}
                </td>
                <td style={{ minWidth: 220 }}>
                  <select
                    className="select sm"
                    value={map[f.key] ?? 'auto'}
                    aria-label={`What "${columnLabel(f.key)}" is`}
                    onChange={e => {
                      const next = { ...map };
                      if (e.target.value === 'auto') delete next[f.key];
                      else next[f.key] = e.target.value as FieldTarget;
                      setMap(next);
                    }}
                  >
                    <option value="auto">{source.fieldMap[f.key] ? 'Automatic' : `Automatic (${TARGET_LABEL[f.as]})`}</option>
                    {(Object.keys(TARGET_LABEL) as FieldTarget[]).map(t => (
                      <option key={t} value={t}>
                        {TARGET_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row wrap">
        <Button
          variant="primary"
          loading={busy}
          disabled={!dirty}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await put<{ fixed: number }>(`/api/lead-sources/${source.id}/fields`, { fieldMap: map });
              toast.success(r.fixed ? `Saved. Fixed the name or email of ${r.fixed} lead${r.fixed === 1 ? '' : 's'} already received.` : 'Saved');
              onSaved();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save columns
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setMap(source.fieldMap)}>
            Undo changes
          </Button>
        )}
      </div>
      <p className="hint">
        Saving also fixes leads already received: a name or email that was kept as a custom field moves to the right place. To send sheet rows again, clear their
        WA Status cells. A number that is already saved is never added twice; only its missing name, email or fields are filled in.
      </p>
    </div>
  );
}

interface LeadEvent {
  id: number;
  status: 'added' | 'updated' | 'duplicate' | 'failed';
  detail: string | null;
  createdAt: string;
  contactId: number | null;
  name: string | null;
  phone: string | null;
}

const KINDS: Array<{ value: Kind; title: string; text: string }> = [
  { value: 'google_sheet', title: 'Google Sheet', text: 'Leads land in a sheet (from ads, forms or your team).' },
  { value: 'website', title: 'Website form', text: 'A form on your own site, WordPress or Elementor.' },
  { value: 'wix', title: 'Wix form', text: 'A form on a Wix website.' },
  { value: 'other', title: 'Other app', text: 'Zapier, Make, Facebook lead ads, a CRM or your developer.' },
];

const KIND_LABEL: Record<Kind, string> = { google_sheet: 'Google Sheet', website: 'Website form', wix: 'Wix form', other: 'Other app' };

export function sheetScript(url: string): string {
  return `// WA Reach: sends each new row of this sheet to your WhatsApp automation.
// The first row must be the column names, with one column called Phone (Name and Email are optional).
const WA_REACH_LINK = '${url}';
const STATUS_COLUMN = 'WA Status';

function sendNewLeads() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return;
  const head = rows[0].map(h => String(h).trim());
  let statusCol = head.indexOf(STATUS_COLUMN);
  if (statusCol < 0) {
    statusCol = head.length;
    sheet.getRange(1, statusCol + 1).setValue(STATUS_COLUMN);
  }
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[statusCol] || row.every(v => v === '')) continue;
    const lead = {};
    head.forEach((h, c) => { if (h && c !== statusCol && row[c] !== '') lead[h] = String(row[c]); });
    const res = UrlFetchApp.fetch(WA_REACH_LINK, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(lead), muteHttpExceptions: true,
    });
    let status = 'Sent to WA Reach';
    if (res.getResponseCode() < 300) {
      try { if (JSON.parse(res.getContentText()).duplicate) status = 'Duplicate (number already a lead)'; } catch (e) {}
    } else {
      try { status = 'Error: ' + JSON.parse(res.getContentText()).error; } catch (e) { status = 'Error ' + res.getResponseCode(); }
    }
    sheet.getRange(i + 1, statusCol + 1).setValue(status);
  }
}
`;
}

function htmlForm(url: string): string {
  return `<form action="${url}" method="POST">
  <input name="name" placeholder="Your name" required>
  <input name="phone" placeholder="WhatsApp number" required>
  <input name="city" placeholder="City">
  <button type="submit">Send</button>
</form>`;
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <Button
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <pre>{code}</pre>
    </div>
  );
}

function SetupSteps({ source }: { source: LeadSource }) {
  const url = source.url!;
  if (source.kind === 'google_sheet') {
    return (
      <div className="stack">
        <ol className="setup-steps">
          <li>Open your leads sheet. Make sure row 1 has column names and one column is called <strong>Phone</strong> (Name, Email, City and any other columns are saved too).</li>
          <li>
            Click <strong>Extensions → Apps Script</strong>, delete everything there, paste the code below and click <strong>Save</strong> (the disk icon).
          </li>
          <li>
            Click the clock icon (<strong>Triggers</strong>) → <strong>Add Trigger</strong> → function <code>sendNewLeads</code>, event source <strong>Time-driven</strong>,{' '}
            <strong>Minutes timer</strong>, <strong>Every minute</strong> → Save. Allow access when Google asks.
          </li>
          <li>Add a test row with your own number. Within a minute a <strong>WA Status</strong> column shows “Sent to WA Reach” and the lead appears below.</li>
          <li>Open <strong>Columns</strong> here to check the name, email and your other columns came through as you expect.</li>
        </ol>
        <CodeBlock code={sheetScript(url)} />
        <p className="hint">Rows are sent once. To resend a row, clear its WA Status cell.</p>
      </div>
    );
  }
  if (source.kind === 'wix') {
    return (
      <ol className="setup-steps">
        <li>
          In your Wix dashboard open <strong>Automations → + New Automation</strong>.
        </li>
        <li>
          Trigger: <strong>Form submitted</strong> and pick your form.
        </li>
        <li>
          Action: <strong>Send HTTP request</strong> (may be called “Send data to a URL”). Method <strong>POST</strong>, paste the link above as the URL, and send the <strong>whole form data</strong> as the body.
        </li>
        <li>Activate it and submit your form once with your own number. The lead shows up below within seconds.</li>
      </ol>
    );
  }
  if (source.kind === 'website') {
    return (
      <div className="stack">
        <p className="secondary small" style={{ margin: 0 }}>
          <strong>WordPress with Elementor:</strong> edit the form → <strong>Actions After Submit</strong> → add <strong>Webhook</strong> → paste the link above. Name the phone field “phone”.
        </p>
        <p className="secondary small" style={{ margin: 0 }}>
          <strong>Any website:</strong> use this form (or set your form's <code>action</code> to the link). After submitting, visitors go to your thank-you page if you set one.
        </p>
        <CodeBlock code={htmlForm(url)} />
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="secondary small" style={{ margin: 0 }}>
        In Zapier, Make, n8n or your CRM, add a <strong>Webhook</strong> step: method <strong>POST</strong>, the link above as the URL, and send the lead as JSON or form fields, for example:
      </p>
      <CodeBlock code={`{ "name": "Asha Rao", "phone": "+91 98765 43210", "email": "asha@example.com", "city": "Pune" }`} />
      <p className="hint">Any extra fields are saved on the contact and can be used in messages, like {'{{city}}'}.</p>
    </div>
  );
}

function SourceEditor({ source, onClose, onSaved }: { source: LeadSource | null; onClose: () => void; onSaved: (s: LeadSource) => void }) {
  const { data: sequences } = useApi<Sequence[]>('/api/sequences');
  const [form, setForm] = useState({
    name: source?.name ?? '',
    kind: source?.kind ?? ('google_sheet' as Kind),
    active: source?.active ?? true,
    thankYouUrl: source?.thankYouUrl ?? '',
    actions: {
      tagIds: source?.actions.tagIds ?? [],
      sequenceId: source?.actions.sequenceId ?? null,
      markOptedIn: source?.actions.markOptedIn ?? false,
      notifyPhone: source?.actions.notifyPhone ? `+${source.actions.notifyPhone}` : '',
    },
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, actions: { ...form.actions, notifyPhone: form.actions.notifyPhone.trim() || null } };
      onSaved(source ? await patch<LeadSource>(`/api/lead-sources/${source.id}`, body) : await post<LeadSource>('/api/lead-sources', body));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const chosen = sequences?.find(s => s.id === form.actions.sequenceId);
  return (
    <Modal
      wide
      title={source ? `Edit ${source.name}` : 'Get leads into WhatsApp automatically'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={() => void save()}>
            {source ? 'Save' : 'Create and show setup'}
          </Button>
        </>
      }
    >
      <div className="stack loose">
        <div className="stack tight">
          <span className="label">When a new lead comes from</span>
          <div className="grid cols-2">
            {KINDS.map(k => (
              <label key={k.value} className={`option-card ${form.kind === k.value ? 'selected' : ''}`}>
                <input type="radio" name="lead-kind" checked={form.kind === k.value} onChange={() => setForm({ ...form, kind: k.value, name: form.name || k.title })} />
                <span>
                  <strong>{k.title}</strong>
                  <br />
                  <span className="small secondary">{k.text}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <Field label="Name" hint="Shown in your contacts and notifications, e.g. “Website enquiry form”.">
          <input className="input" value={form.name} maxLength={80} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={KIND_LABEL[form.kind]} />
        </Field>
        <Field
          label="Tag every lead from this source"
          hint="Type a tag and press Enter, e.g. “website-lead” or “diwali-form”. Every lead from here gets it, including leads already received, so you can filter them in Leads and send them campaigns."
        >
          <TagPicker value={form.actions.tagIds} placeholder="Add or create a tag…" onChange={tagIds => setForm({ ...form, actions: { ...form.actions, tagIds } })} />
        </Field>
        <div className="stack tight">
          <span className="label">Then do this</span>
          <div className="grid cols-2">
            <Field label="Start a follow-up series" hint={chosen ? `First message goes ${chosen.steps[0]?.delayMinutes ? 'after the delay you set' : 'within a minute'}.` : 'Tip: a series whose first message waits 0 minutes sends an instant welcome.'}>
              <select className="select" value={form.actions.sequenceId ?? ''} onChange={e => setForm({ ...form, actions: { ...form.actions, sequenceId: e.target.value ? Number(e.target.value) : null } })}>
                <option value="">Don't send anything</option>
                {sequences?.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.active ? '' : ' (paused)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tell me on WhatsApp" hint="Each new lead is sent to this number from your default WhatsApp number. Leave empty to skip.">
              <input className="input" value={form.actions.notifyPhone} onChange={e => setForm({ ...form, actions: { ...form.actions, notifyPhone: e.target.value } })} placeholder="+91 98765 43210" />
            </Field>
            {form.kind === 'website' && (
              <Field label="Thank-you page (optional)" hint="Where visitors go after submitting a plain HTML form.">
                <input className="input" value={form.thankYouUrl} onChange={e => setForm({ ...form, thankYouUrl: e.target.value })} placeholder="https://your-site.com/thank-you" />
              </Field>
            )}
          </div>
          <Toggle
            checked={form.actions.markOptedIn}
            onChange={markOptedIn => setForm({ ...form, actions: { ...form.actions, markOptedIn } })}
            label="The form asks permission to message them on WhatsApp"
            description="Records these leads as opted in, so campaigns for opted-in contacts include them."
          />
          {source && <Toggle checked={form.active} onChange={active => setForm({ ...form, active })} label="Active" description="When off, the link refuses new leads." />}
        </div>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

function SourceDetail({ sourceId, onClose, onEdit, onChanged }: { sourceId: number; onClose: () => void; onEdit: (s: LeadSource) => void; onChanged: () => void }) {
  const { data, error, reload } = useApi<{ source: LeadSource; events: LeadEvent[]; columns: ColumnInfo }>(`/api/lead-sources/${sourceId}`, { poll: 5000 });
  const [view, setView] = useState<'setup' | 'columns' | 'leads'>('setup');
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const source = data?.source;
  return (
    <Modal
      wide
      title={source ? source.name : 'Lead source'}
      onClose={onClose}
      footer={
        source && (
          <>
            <Button
              variant="danger"
              onClick={async () => {
                if (await confirm('Reset this link?', 'The current link stops working immediately. You will need to paste the new one wherever you used the old one.', { confirmLabel: 'Reset link', danger: true })) {
                  await post(`/api/lead-sources/${source.id}/reset-link`);
                  toast.success('New link created');
                  await reload();
                }
              }}
            >
              Reset link
            </Button>
            <span className="spacer" />
            <Button onClick={() => onEdit(source)}>Edit actions</Button>
            <Button
              variant="primary"
              onClick={() => {
                onChanged();
                onClose();
              }}
            >
              Done
            </Button>
          </>
        )
      }
    >
      <ErrorNote error={error} />
      {!source ? (
        <Loading />
      ) : (
        <div className="stack">
          {source.lastReceivedAt ? (
            <Callout tone="success">
              Working: last lead {relativeTime(source.lastReceivedAt)}. {source.received} received{source.failed ? `, ${source.failed} could not be added` : ''}.
            </Callout>
          ) : (
            <Callout>Waiting for the first lead… Follow the steps below and send yourself a test lead. This updates on its own.</Callout>
          )}
          {data.columns.missingName > 0 && view !== 'columns' && source.fieldsSeen.some(f => f.as === 'custom') && (
            <Callout tone="warn">
              {data.columns.missingName} lead{data.columns.missingName === 1 ? '' : 's'} from here {data.columns.missingName === 1 ? 'has' : 'have'} no name.{' '}
              <button type="button" className="link-button" onClick={() => setView('columns')}>
                Choose which column is the name
              </button>
            </Callout>
          )}
          {source.url && <CopyField label="Your private lead link" value={source.url} hint="Anyone with this link can add leads to your account, so share it only with your form or sheet." />}
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'setup', label: `How to connect ${KIND_LABEL[source.kind]}` },
              { value: 'columns', label: `Columns (${source.fieldsSeen.length})` },
              { value: 'leads', label: `Recent leads (${data.events.length})` },
            ]}
          />
          {view === 'setup' && source.url && <SetupSteps source={source} />}
          {view === 'columns' && <ColumnsEditor key={JSON.stringify(source.fieldMap)} source={source} info={data.columns} onSaved={() => void reload()} />}
          {view === 'leads' &&
            (data.events.length === 0 ? (
              <p className="secondary">No leads yet.</p>
            ) : (
              <div className="lead-log">
                {data.events.map(e => (
                  <div key={e.id} className="lead-log-row">
                    <Badge tone={e.status === 'failed' ? 'red' : e.status === 'added' ? 'green' : e.status === 'duplicate' ? 'amber' : undefined}>
                      {e.status === 'added' ? 'New lead' : e.status === 'updated' ? 'Existing contact' : e.status === 'duplicate' ? 'Duplicate' : 'Not added'}
                    </Badge>
                    <span className="grow">
                      {e.status === 'failed' ? (
                        <span className="small error-text">{e.detail}</span>
                      ) : (
                        <>
                          {`${e.name ?? 'No name'}${e.phone ? `, ${formatPhone(e.phone)}` : ''}`}
                          {e.status === 'duplicate' && e.detail && <span className="small muted"> · {e.detail}</span>}
                        </>
                      )}
                    </span>
                    <span className="small muted">{relativeTime(e.createdAt)}</span>
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}
      {dialog}
    </Modal>
  );
}

export function LeadSourcesTab() {
  const { data, error, loading, reload } = useApi<{ items: LeadSource[]; available: boolean }>('/api/lead-sources', { poll: 15000 });
  const { data: sequences } = useApi<Sequence[]>('/api/sequences');
  const [editing, setEditing] = useState<{ source: LeadSource | null } | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const { confirm, dialog } = useConfirm();
  const items = data?.items ?? [];
  return (
    <div className="stack">
      <ErrorNote error={error} />
      {data && !data.available && <Callout tone="warn">This server has no public address yet (PUBLIC_URL), so outside tools can't send leads. Ask your administrator to set it.</Callout>}
      <Card
        title="Leads from forms and sheets"
        subtitle="New leads from your website, Google Sheet or Wix become contacts and get your WhatsApp welcome automatically."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setEditing({ source: null })} disabled={data && !data.available}>
            Connect a lead source
          </Button>
        }
      >
        {loading && !data ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty title="No lead sources yet" action={<Button variant="primary" onClick={() => setEditing({ source: null })}>Connect your first form or sheet</Button>}>
            Pick where leads come from and what should happen. You get a private link and step-by-step setup.
          </Empty>
        ) : (
          <div className="lead-sources">
            {items.map(s => {
              const sequence = sequences?.find(q => q.id === s.actions.sequenceId);
              return (
                <div key={s.id} className="lead-source">
                  <div className="stack tight grow">
                    <div className="row wrap">
                      <strong>{s.name}</strong>
                      <Badge>{KIND_LABEL[s.kind]}</Badge>
                      {!s.active ? <Badge tone="amber">Off</Badge> : s.lastReceivedAt ? <Badge tone="green">Working</Badge> : <Badge tone="blue">Waiting for first lead</Badge>}
                    </div>
                    <span className="small secondary">
                      {sequence ? `Starts “${sequence.name}”` : 'No message'}
                      {s.actions.tagIds.length ? `, adds ${s.actions.tagIds.length} tag${s.actions.tagIds.length > 1 ? 's' : ''}` : ''}
                      {s.actions.notifyPhone ? ', notifies you' : ''}
                      {s.lastReceivedAt ? `. Last lead ${relativeTime(s.lastReceivedAt)}, ${s.received} total` : ''}
                      {s.failed ? `, ${s.failed} not added` : ''}
                    </span>
                  </div>
                  <div className="row">
                    <Button size="sm" variant="primary" onClick={() => setViewing(s.id)}>
                      Setup and leads
                    </Button>
                    <Button size="sm" onClick={() => setEditing({ source: s })}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (await confirm('Delete this lead source?', 'Its link stops working. Contacts already added stay.', { confirmLabel: 'Delete', danger: true })) {
                          await del(`/api/lead-sources/${s.id}`);
                          await reload();
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {editing && (
        <SourceEditor
          source={editing.source}
          onClose={() => setEditing(null)}
          onSaved={saved => {
            setEditing(null);
            void reload();
            setViewing(saved.id);
          }}
        />
      )}
      {viewing !== null && (
        <SourceDetail
          sourceId={viewing}
          onClose={() => setViewing(null)}
          onChanged={() => void reload()}
          onEdit={s => {
            setViewing(null);
            setEditing({ source: s });
          }}
        />
      )}
      {dialog}
    </div>
  );
}
