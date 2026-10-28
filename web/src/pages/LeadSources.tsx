import { useState } from 'react';
import { del, patch, post, put, useApi, errorMessage, type Sequence } from '../api';
import { Badge, Button, Callout, Card, Empty, ErrorNote, Field, Loading, Modal, Segmented, Toggle, useConfirm, useToast } from '../components/ui';
import { IconPlus } from '../components/icons';
import { TagPicker } from '../components/pickers';
import { CopyField } from '../components/official';
import { formatDateTime, formatPhone, relativeTime } from '../format';
import { sheetScript } from '../sheet-script';

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
  sheet: { mode: 'all' | 'only'; selected: string[]; existing: 'skip' | 'import'; tabs: string[]; syncedAt: string | null };
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
  savedAs: Record<string, string>;
  leads: number;
  missingName: number;
  missingEmail: number;
}

/** "Pincode" → "pincode", the way the server names custom fields. */
const toKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);

function ColumnsEditor({ source, info, onSaved }: { source: LeadSource; info?: ColumnInfo; onSaved: () => void }) {
  const toast = useToast();
  const [map, setMap] = useState<Record<string, FieldTarget>>(source.fieldMap);
  const savedName = (key: string) => info?.savedAs[key] ?? key;
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(source.fieldsSeen.map(f => [f.key, columnLabel(info?.savedAs[f.key] ?? f.key)])),
  );
  const [busy, setBusy] = useState(false);
  if (source.fieldsSeen.length === 0) {
    return <p className="secondary">The columns of your {KIND_LABEL[source.kind].toLowerCase()} show here after the first lead arrives, so you can check each one was understood.</p>;
  }
  const targetOf = (f: { key: string; as: FieldTarget }) => map[f.key] ?? (source.fieldMap[f.key] ? 'custom' : f.as);
  const renamed = source.fieldsSeen.filter(f => targetOf(f) === 'custom' && toKey(names[f.key] ?? '') && toKey(names[f.key]) !== savedName(f.key));
  const mapDirty = JSON.stringify(map) !== JSON.stringify(source.fieldMap);
  const dirty = mapDirty || renamed.length > 0;
  const nameChosen = source.fieldsSeen.some(f => ['name', 'first_name'].includes(targetOf(f)));

  const save = async () => {
    setBusy(true);
    try {
      let fixed = 0;
      if (mapDirty) fixed = (await put<{ fixed: number }>(`/api/lead-sources/${source.id}/fields`, { fieldMap: map })).fixed;
      for (const f of renamed) await post('/api/contacts/fields/rename', { from: savedName(f.key), to: names[f.key] });
      const parts = [fixed ? `fixed the name or email of ${fixed} lead${fixed === 1 ? '' : 's'} already received` : '', renamed.length ? `renamed ${renamed.length} field${renamed.length === 1 ? '' : 's'} for all contacts` : '']
        .filter(Boolean)
        .join(', and ');
      toast.success(parts ? `Saved: ${parts}.` : 'Saved');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {info && info.missingName > 0 && !nameChosen && (
        <Callout tone="warn">
          {info.missingName === info.leads ? 'Leads from here have no name.' : `${info.missingName} of ${info.leads} leads from here have no name.`} If your form sends coded
          column names (like “text-870”), look at the examples, set the column that holds the name to <strong>Full name</strong>, and save. Leads already received are fixed
          too.
        </Callout>
      )}
      <p className="secondary small">
        Each column your {KIND_LABEL[source.kind].toLowerCase()} sends, an example from your latest lead, and where it is saved. Change any that are wrong, and give custom
        fields a clear name. Custom fields show in Contacts, can be filtered on, and can go into messages.
      </p>
      <div className="table-wrap">
        <table className="table columns-table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Example</th>
              <th>Saved as</th>
            </tr>
          </thead>
          <tbody>
            {source.fieldsSeen.map(f => {
              const target = targetOf(f);
              const sample = info?.samples[f.key];
              return (
                <tr key={f.key}>
                  <td className="nowrap">{columnLabel(f.key)}</td>
                  <td className="column-example">
                    {sample ? (
                      <span title={sample}>{sample}</span>
                    ) : target === 'country_code' ? (
                      <span className="muted">Added in front of the phone number</span>
                    ) : target === 'ignore' ? (
                      <span className="muted">Not saved</span>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td style={{ minWidth: 230 }}>
                    <div className="stack tight">
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
                        <option value="auto">{source.fieldMap[f.key] ? 'Automatic' : `Automatic: ${TARGET_LABEL[f.as]}`}</option>
                        {(Object.keys(TARGET_LABEL) as FieldTarget[]).map(t => (
                          <option key={t} value={t}>
                            {TARGET_LABEL[t]}
                          </option>
                        ))}
                      </select>
                      {target === 'custom' && (
                        <label className="field-name">
                          <span className="small muted">Field name</span>
                          <input
                            className="input sm"
                            value={names[f.key] ?? ''}
                            maxLength={64}
                            onChange={e => setNames({ ...names, [f.key]: e.target.value })}
                            aria-label={`Name of the custom field for "${columnLabel(f.key)}"`}
                          />
                          <code className="small muted">{`{{${toKey(names[f.key] ?? '') || savedName(f.key)}}}`}</code>
                        </label>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row wrap">
        <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
          Save columns
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            onClick={() => {
              setMap(source.fieldMap);
              setNames(Object.fromEntries(source.fieldsSeen.map(f => [f.key, columnLabel(savedName(f.key))])));
            }}
          >
            Undo changes
          </Button>
        )}
      </div>
      <p className="hint">
        Saving fixes leads already received too: a name or email kept as a custom field moves to the right place, and a renamed field is renamed for all contacts. To send
        sheet rows again, clear their WA Status cells. A number already saved is never added twice; only its missing details are filled in.
      </p>
    </div>
  );
}

function SheetTabs({ source, onSaved }: { source: LeadSource; onSaved: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState(source.sheet.mode);
  const [selected, setSelected] = useState<string[]>(source.sheet.selected);
  const [existing, setExisting] = useState(source.sheet.existing);
  const [busy, setBusy] = useState(false);
  const tabs = [...source.sheet.tabs, ...selected.filter(t => !source.sheet.tabs.includes(t))];
  const dirty = mode !== source.sheet.mode || existing !== source.sheet.existing || JSON.stringify([...selected].sort()) !== JSON.stringify([...source.sheet.selected].sort());
  return (
    <div className="stack">
      {source.sheet.syncedAt ? (
        <p className="small muted" style={{ margin: 0 }}>
          Your sheet last checked in {relativeTime(source.sheet.syncedAt)}. Changes here apply within a minute; no need to change the script.
        </p>
      ) : (
        <Callout tone="warn">
          {source.lastReceivedAt
            ? 'Your sheet uses the older script, which reads only the first tab. '
            : 'Your sheet has not checked in yet. '}
          Paste the latest script (see <strong>How to connect Google Sheet</strong>) and its tabs show here within a minute.
        </Callout>
      )}
      <div className="stack tight">
        <span className="label">Which tabs to read</span>
        <label className="row" style={{ gap: 8 }}>
          <input type="radio" name="sheet-mode" checked={mode === 'all'} onChange={() => setMode('all')} />
          All tabs, including tabs you add later
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input type="radio" name="sheet-mode" checked={mode === 'only'} onChange={() => setMode('only')} />
          Only the tabs I tick
        </label>
        {tabs.length > 0 && (
          <div className="sheet-tabs">
            {tabs.map(t => (
              <label key={t} className="row" style={{ gap: 8, opacity: mode === 'all' ? 0.7 : 1 }}>
                <input
                  type="checkbox"
                  disabled={mode === 'all'}
                  checked={mode === 'all' || selected.includes(t)}
                  onChange={e => setSelected(e.target.checked ? [...selected, t] : selected.filter(x => x !== t))}
                />
                {t}
                {!source.sheet.tabs.includes(t) && <span className="small muted">(not in the sheet any more)</span>}
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="stack tight">
        <span className="label">Rows that were already in a tab when WA Reach first reads it</span>
        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <input type="radio" name="sheet-existing" checked={existing === 'skip'} onChange={() => setExisting('skip')} />
          <span>
            Leave them alone <span className="muted">(recommended)</span>
            <br />
            <span className="small muted">They are marked “Not sent” in the WA Status column. Only rows added from then on are sent.</span>
          </span>
        </label>
        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <input type="radio" name="sheet-existing" checked={existing === 'import'} onChange={() => setExisting('import')} />
          <span>
            Add them as contacts too, without sending them any message
            <br />
            <span className="small muted">They get the source’s tags but no welcome series, so old leads are not all messaged at once.</span>
          </span>
        </label>
      </div>
      <div className="row wrap">
        <Button
          variant="primary"
          loading={busy}
          disabled={!dirty || (mode === 'only' && selected.length === 0)}
          onClick={async () => {
            setBusy(true);
            try {
              await put(`/api/lead-sources/${source.id}/sheet`, { mode, selected, existing });
              toast.success('Saved. Your sheet picks this up within a minute.');
              onSaved();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save tabs
        </Button>
        {mode === 'only' && selected.length === 0 && <span className="small muted">Tick at least one tab.</span>}
      </div>
      <p className="hint">Each lead gets a “Sheet tab” custom field, so you can filter Contacts by the form it came from.</p>
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
          <li>
            Open your leads sheet. In each tab, row 1 must have the column names, including a phone number column (Name, Email, City and any other columns are saved
            too).
          </li>
          <li>
            Click <strong>Extensions → Apps Script</strong>, delete everything there, paste the code below and click <strong>Save</strong> (the disk icon).
          </li>
          <li>
            Click the clock icon (<strong>Triggers</strong>) → <strong>Add Trigger</strong> → function <code>sendNewLeads</code>, event source <strong>Time-driven</strong>,{' '}
            <strong>Minutes timer</strong>, <strong>Every minute</strong> → Save. Allow access when Google asks.
          </li>
          <li>
            Within a minute your tabs appear under <strong>Sheet tabs</strong> here: choose which tabs to read. Rows already in a tab are marked “Not sent” and nobody is
            messaged, unless you choose to add them quietly.
          </li>
          <li>Add a test row with your own number. Within a minute its <strong>WA Status</strong> shows “Sent to WA Reach” and the lead appears below.</li>
          <li>Open <strong>Columns</strong> here to check the name, email and your other columns came through as you expect.</li>
        </ol>
        <CodeBlock code={sheetScript(url)} />
        <p className="hint">
          Rows are sent once. To resend a row, clear its WA Status cell. Already using an older version of this script? Paste this one over it to choose tabs; rows
          already sent are not sent again.
        </p>
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
  const [view, setView] = useState<'setup' | 'tabs' | 'columns' | 'leads'>('setup');
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
              ...(source.kind === 'google_sheet' ? [{ value: 'tabs' as const, label: `Sheet tabs (${source.sheet.tabs.length})` }] : []),
              { value: 'columns', label: `Columns (${source.fieldsSeen.length})` },
              { value: 'leads', label: `Recent leads (${data.events.length})` },
            ]}
          />
          {view === 'setup' && source.url && <SetupSteps source={source} />}
          {view === 'tabs' && <SheetTabs key={JSON.stringify(source.sheet)} source={source} onSaved={() => void reload()} />}
          {view === 'columns' && (
            <ColumnsEditor
              key={JSON.stringify([source.fieldMap, data.columns.savedAs, source.fieldsSeen.length])}
              source={source}
              info={data.columns}
              onSaved={() => void reload()}
            />
          )}
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
                    <span className="small muted nowrap" title={relativeTime(e.createdAt)}>
                      {formatDateTime(e.createdAt)}
                    </span>
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
