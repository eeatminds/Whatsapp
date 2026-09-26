import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, patch, post, useApi, errorMessage, type AutoReply, type Sequence, type Step, type Tag } from '../api';
import { Badge, Button, Callout, Card, Empty, ErrorNote, Field, Loading, Modal, PageHeader, Pagination, Tabs, TagChip, Toggle, useConfirm, useToast } from '../components/ui';
import { IconPlus, IconTrash } from '../components/icons';
import { Composer, MessagePreview, WhatsAppText } from '../components/composer';
import { SessionSelect, TagPicker, useTags } from '../components/pickers';
import { formatDuration, formatNumber, formatPhone, relativeTime, formatDateTime } from '../format';

const MATCH_LABEL: Record<AutoReply['matchType'], string> = {
  exact: 'Message is exactly',
  contains: 'Message contains',
  starts_with: 'Message starts with',
  regex: 'Message matches pattern',
  any: 'Any other message',
};

// ---------------------------------------------------------------- auto-replies

type AutoReplyForm = Omit<AutoReply, 'id' | 'hitCount' | 'lastHitAt'>;

function emptyRule(): AutoReplyForm {
  return {
    name: '',
    active: true,
    priority: 100,
    matchType: 'contains',
    keywords: [],
    replyBody: '',
    replyMediaId: null,
    actions: { addTagIds: [], removeTagIds: [], setConsent: null, enrollSequenceId: null },
    sessionId: null,
    cooldownMinutes: 60,
  };
}

function AutoReplyEditor({ rule, onClose, onSaved }: { rule: AutoReply | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<AutoReplyForm>(rule ?? emptyRule());
  const [keywordText, setKeywordText] = useState((rule?.keywords ?? []).join(', '));
  const { data: sequences } = useApi<Sequence[]>('/api/sequences');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keywords = form.matchType === 'regex' ? keywordText.split('\n').map(k => k.trim()).filter(Boolean) : keywordText.split(',').map(k => k.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, keywords };
      if (rule) await patch(`/api/auto-replies/${rule.id}`, body);
      else await post('/api/auto-replies', body);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={rule ? 'Edit auto-reply' : 'New auto-reply'}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <ErrorNote error={error} />
      <div className="grid cols-2">
        <Field label="Name">
          <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Price enquiry" />
        </Field>
        <Field label="When">
          <select className="select" value={form.matchType} onChange={e => setForm({ ...form, matchType: e.target.value as AutoReply['matchType'] })}>
            {Object.entries(MATCH_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {form.matchType !== 'any' && (
        <Field
          label={form.matchType === 'regex' ? 'Patterns (one per line)' : 'Keywords (comma separated)'}
          hint={form.matchType === 'regex' ? 'JavaScript regular expressions, case-insensitive.' : 'Case and punctuation are ignored: “Price?” matches “price”. Whole words only for “contains”.'}
        >
          {form.matchType === 'regex' ? (
            <textarea className="textarea" rows={3} value={keywordText} onChange={e => setKeywordText(e.target.value)} placeholder="^order\s*#?\d+$" />
          ) : (
            <input className="input" value={keywordText} onChange={e => setKeywordText(e.target.value)} placeholder="price, rate card, cost" />
          )}
        </Field>
      )}
      <div className="grid cols-2">
        <div className="stack">
          <span className="label">Reply</span>
          <Composer body={form.replyBody} mediaId={form.replyMediaId} onChange={m => setForm({ ...form, replyBody: m.body, replyMediaId: m.mediaId })} rows={5} placeholder="Hi {{first_name|there}}! Here is our price list…" />
        </div>
        <MessagePreview body={form.replyBody} mediaId={form.replyMediaId} />
      </div>
      <div className="divider" />
      <div className="grid cols-2">
        <Field label="Also add tags">
          <TagPicker value={form.actions.addTagIds} onChange={addTagIds => setForm({ ...form, actions: { ...form.actions, addTagIds } })} />
        </Field>
        <Field label="Remove tags">
          <TagPicker value={form.actions.removeTagIds} onChange={removeTagIds => setForm({ ...form, actions: { ...form.actions, removeTagIds } })} allowCreate={false} />
        </Field>
        <Field label="Start drip sequence">
          <select
            className="select"
            value={form.actions.enrollSequenceId ?? ''}
            onChange={e => setForm({ ...form, actions: { ...form.actions, enrollSequenceId: Number(e.target.value) || null } })}
          >
            <option value="">None</option>
            {sequences?.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Record consent" hint="A keyword like JOIN is the contact's own opt-in.">
          <select
            className="select"
            value={form.actions.setConsent ?? ''}
            onChange={e => setForm({ ...form, actions: { ...form.actions, setConsent: (e.target.value || null) as AutoReply['actions']['setConsent'] } })}
          >
            <option value="">Leave unchanged</option>
            <option value="opted_in">Mark as opted in</option>
            <option value="opted_out">Mark as opted out</option>
          </select>
        </Field>
        <Field label="Only on number">
          <SessionSelect value={form.sessionId} onChange={sessionId => setForm({ ...form, sessionId })} allowDefault />
        </Field>
        <Field label="Don't repeat to the same person within (minutes)" hint="Stops a chatty contact from getting the same reply over and over.">
          <input className="input" type="number" min={0} value={form.cooldownMinutes} onChange={e => setForm({ ...form, cooldownMinutes: Number(e.target.value) })} />
        </Field>
        <Field label="Priority" hint="Lower numbers are checked first. Only the first matching rule runs.">
          <input className="input" type="number" min={0} max={1000} value={form.priority} onChange={e => setForm({ ...form, priority: Number(e.target.value) })} />
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <Toggle checked={form.active} onChange={active => setForm({ ...form, active })} label="Active" />
        </div>
      </div>
    </Modal>
  );
}

function AutoRepliesTab() {
  const { data, error, loading, reload } = useApi<AutoReply[]>('/api/auto-replies');
  const { data: tags } = useTags();
  const [editing, setEditing] = useState<AutoReply | 'new' | null>(null);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const tagById = (id: number): Tag | undefined => tags?.find(t => t.id === id);

  return (
    <div className="stack loose">
      {data && data.length > 0 && data.every(r => !r.active) && (
        <Callout tone="success">
          <strong>Ready-made examples, all switched off.</strong> Open one, replace the text in [square brackets] with your details, then switch it
          on and check it with <em>Try it</em> below. The greeting menu works together with the Price list, Location and Talk-to-a-person replies,
          so switch those on too.
        </Callout>
      )}
      <Callout>
        STOP and START (and the other keywords in <Link to="/settings">Settings</Link>) are handled automatically: they update consent and send a confirmation before any rule below runs.
      </Callout>
      <Card
        title="Keyword auto-replies"
        subtitle="Answer common questions instantly, tag leads and start drip sequences from a keyword."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setEditing('new')}>
            New auto-reply
          </Button>
        }
        bodyClass=""
      >
        <ErrorNote error={error} />
        {loading && !data ? (
          <Loading />
        ) : data?.length === 0 ? (
          <Empty title="No auto-replies yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Create one</Button>}>
            Example: when someone writes “price”, send your rate card and tag them “pricing-lead”.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Trigger</th>
                  <th>Does</th>
                  <th className="num">Used</th>
                  <th>Active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.map(r => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                      <div className="small muted">Priority {r.priority}</div>
                    </td>
                    <td style={{ maxWidth: 260 }}>
                      <div className="small secondary">{MATCH_LABEL[r.matchType]}</div>
                      <div className="row wrap" style={{ gap: 4 }}>
                        {r.keywords.slice(0, 5).map(k => (
                          <code key={k}>{k}</code>
                        ))}
                        {r.keywords.length > 5 && <span className="small muted">+{r.keywords.length - 5}</span>}
                      </div>
                    </td>
                    <td style={{ maxWidth: 320 }}>
                      {r.replyBody && (
                        <div className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 44, overflow: 'hidden' }}>
                          <WhatsAppText text={r.replyBody} />
                        </div>
                      )}
                      <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                        {r.actions.addTagIds.map(id => {
                          const tag = tagById(id);
                          return tag ? <TagChip key={id} tag={{ ...tag, name: `+ ${tag.name}` }} /> : null;
                        })}
                        {r.actions.setConsent && <Badge tone={r.actions.setConsent === 'opted_in' ? 'green' : 'red'}>{r.actions.setConsent === 'opted_in' ? 'Opts in' : 'Opts out'}</Badge>}
                        {r.actions.enrollSequenceId && <Badge tone="blue">Starts drip</Badge>}
                      </div>
                    </td>
                    <td className="num">
                      {formatNumber(r.hitCount)}
                      {r.lastHitAt && <div className="small muted">{relativeTime(r.lastHitAt)}</div>}
                    </td>
                    <td>
                      <Toggle
                        checked={r.active}
                        label={<span className="sr-only">Active</span>}
                        onChange={async active => {
                          try {
                            await patch(`/api/auto-replies/${r.id}`, { ...r, active });
                            void reload();
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      />
                    </td>
                    <td className="right nowrap">
                      <Button size="sm" onClick={() => setEditing(r)}>
                        Edit
                      </Button>{' '}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconTrash size={15} />}
                        aria-label="Delete rule"
                        onClick={async () => {
                          if (await confirm(`Delete “${r.name}”?`, 'Contacts are not affected.', { confirmLabel: 'Delete', danger: true })) {
                            await del(`/api/auto-replies/${r.id}`);
                            void reload();
                          }
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Try it" subtitle="Type a message the way a customer would, and see what happens.">
        <form
          className="row wrap"
          onSubmit={async e => {
            e.preventDefault();
            const r = await post<{ match: string | null; rule?: AutoReply }>('/api/auto-replies/test', { text: testText });
            setTestResult(
              r.match === 'opt_out'
                ? 'Unsubscribes the contact and sends the opt-out confirmation.'
                : r.match === 'opt_in'
                  ? 'Subscribes the contact and sends the opt-in confirmation.'
                  : r.rule
                    ? `Matches “${r.rule.name}”.`
                    : 'No rule matches; the message just lands in the inbox.',
            );
          }}
        >
          <input className="input" style={{ flex: '1 1 260px' }} value={testText} onChange={e => setTestText(e.target.value)} placeholder="e.g. What's the price for 2 kg?" />
          <Button type="submit" disabled={!testText.trim()}>
            Test
          </Button>
        </form>
        {testResult && <p style={{ marginTop: 10 }}>{testResult}</p>}
      </Card>
      {editing && <AutoReplyEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------- drip sequences

type DelayUnit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 };

function splitDelay(minutes: number): { value: number; unit: DelayUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes > 0 && minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

function StepEditor({ step, index, onChange, onRemove }: { step: Step; index: number; onChange: (s: Step) => void; onRemove?: () => void }) {
  const delay = splitDelay(step.delayMinutes);
  return (
    <>
      <div className="step-connector">
        <div className="row wrap">
          <span>{index === 0 ? 'Wait after enrollment' : 'Then wait'}</span>
          <input
            className="input sm"
            type="number"
            min={0}
            style={{ width: 80 }}
            value={delay.value}
            onChange={e => onChange({ ...step, delayMinutes: Math.max(0, Number(e.target.value)) * UNIT_MINUTES[delay.unit] })}
            aria-label="Delay"
          />
          <select className="select sm" style={{ width: 'auto' }} value={delay.unit} onChange={e => onChange({ ...step, delayMinutes: delay.value * UNIT_MINUTES[e.target.value as DelayUnit] })} aria-label="Delay unit">
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      </div>
      <div className="step-card">
        <div className="card-header">
          <h3>Message {index + 1}</h3>
          {onRemove && <Button size="sm" variant="ghost" icon={<IconTrash size={15} />} aria-label={`Remove message ${index + 1}`} onClick={onRemove} />}
        </div>
        <div className="card-body">
          <Composer body={step.body} mediaId={step.mediaId} onChange={m => onChange({ ...step, body: m.body, mediaId: m.mediaId })} rows={4} />
        </div>
      </div>
    </>
  );
}

function SequenceEditor({ sequence, onClose, onSaved }: { sequence: Sequence | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: sequence?.name ?? '',
    active: sequence?.active ?? true,
    sessionId: sequence?.sessionId ?? null,
    trigger: sequence?.trigger ?? ({ type: 'manual' } as Sequence['trigger']),
    steps: sequence?.steps ?? [{ delayMinutes: 0, body: '', mediaId: null }],
    options: sequence?.options ?? { stopOnReply: true, respectQuietHours: true, requireOptIn: false, appendOptOut: true },
  });
  const { data: tags } = useTags();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = form.steps.reduce((sum, s) => sum + s.delayMinutes, 0);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (sequence) await patch(`/api/sequences/${sequence.id}`, form);
      else await post('/api/sequences', form);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={sequence ? 'Edit drip sequence' : 'New drip sequence'}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="secondary small" style={{ marginRight: 'auto' }}>
            {form.steps.length} messages over {formatDuration(total)}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.name.trim() || form.steps.some(s => !s.body.trim() && !s.mediaId)} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <ErrorNote error={error} />
      <div className="grid cols-2">
        <Field label="Name">
          <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. New lead welcome" />
        </Field>
        <Field label="Send from">
          <SessionSelect value={form.sessionId} onChange={sessionId => setForm({ ...form, sessionId })} allowDefault />
        </Field>
        <Field label="Start for a contact when">
          <select
            className="select"
            value={form.trigger.type}
            onChange={e => {
              const type = e.target.value as Sequence['trigger']['type'];
              setForm({ ...form, trigger: type === 'tag_added' ? { type, tagId: tags?.[0]?.id ?? 0 } : { type } });
            }}
          >
            <option value="manual">I enroll them (Contacts page, or an auto-reply)</option>
            <option value="tag_added">A tag is added to them</option>
            <option value="opted_in">They opt in</option>
          </select>
        </Field>
        {form.trigger.type === 'tag_added' && (
          <Field label="Tag">
            <select className="select" value={form.trigger.tagId || ''} onChange={e => setForm({ ...form, trigger: { type: 'tag_added', tagId: Number(e.target.value) } })}>
              <option value="">Choose tag…</option>
              {tags?.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <div>
        {form.steps.map((step, i) => (
          <StepEditor
            key={i}
            step={step}
            index={i}
            onChange={s => setForm({ ...form, steps: form.steps.map((x, j) => (j === i ? s : x)) })}
            onRemove={form.steps.length > 1 ? () => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) }) : undefined}
          />
        ))}
        <div className="step-connector">
          <Button size="sm" icon={<IconPlus size={14} />} onClick={() => setForm({ ...form, steps: [...form.steps, { delayMinutes: 1440, body: '', mediaId: null }] })}>
            Add message
          </Button>
        </div>
      </div>
      <div className="grid cols-2">
        <Toggle checked={form.options.stopOnReply} onChange={stopOnReply => setForm({ ...form, options: { ...form.options, stopOnReply } })} label="Stop when they reply" description="Hand the conversation to a human." />
        <Toggle checked={form.options.respectQuietHours} onChange={respectQuietHours => setForm({ ...form, options: { ...form.options, respectQuietHours } })} label="Respect quiet hours" />
        <Toggle checked={form.options.requireOptIn} onChange={requireOptIn => setForm({ ...form, options: { ...form.options, requireOptIn } })} label="Opted-in contacts only" />
        <Toggle checked={form.options.appendOptOut} onChange={appendOptOut => setForm({ ...form, options: { ...form.options, appendOptOut } })} label="Add unsubscribe line" />
        <Toggle checked={form.active} onChange={active => setForm({ ...form, active })} label="Active" description="Paused sequences keep their enrollments but send nothing." />
      </div>
    </Modal>
  );
}

function EnrollmentsModal({ sequence, onClose }: { sequence: Sequence; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const { data, reload } = useApi<{ total: number; items: Array<{ id: number; name: string | null; phone: string; status: string; currentStep: number; nextRunAt: string | null; stopReason: string | null; enrolledAt: string }> }>(
    `/api/sequences/${sequence.id}/enrollments?page=${page}&pageSize=25`,
  );
  return (
    <Modal title={`${sequence.name}: contacts`} wide onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {data?.items.length === 0 ? (
        <Empty title="Nobody enrolled yet">
          {sequence.trigger.type === 'manual' ? 'Select contacts on the Contacts page and choose “Enroll in sequence”.' : 'Contacts are enrolled automatically by the trigger.'}
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Next message</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.items.map(e => (
                  <tr key={e.id}>
                    <td>{e.name || formatPhone(e.phone)}</td>
                    <td>
                      <Badge tone={e.status === 'active' ? 'green' : e.status === 'stopped' ? 'amber' : undefined}>{e.status}</Badge>
                      {e.stopReason && <div className="small muted">{e.stopReason.replace(/_/g, ' ')}</div>}
                    </td>
                    <td className="num">
                      {Math.min(e.currentStep, sequence.steps.length)} / {sequence.steps.length}
                    </td>
                    <td className="small secondary">{e.status === 'active' ? formatDateTime(e.nextRunAt) : '–'}</td>
                    <td className="right">
                      {e.status === 'active' && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            await post(`/api/sequences/enrollments/${e.id}/stop`);
                            void reload();
                          }}
                        >
                          Stop
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />}
        </>
      )}
    </Modal>
  );
}

function SequencesTab() {
  const { data, error, loading, reload } = useApi<Sequence[]>('/api/sequences');
  const { data: tags } = useTags();
  const [editing, setEditing] = useState<Sequence | 'new' | null>(null);
  const [viewing, setViewing] = useState<Sequence | null>(null);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const triggerText = (s: Sequence) =>
    s.trigger.type === 'tag_added'
      ? `When tagged “${tags?.find(t => s.trigger.type === 'tag_added' && t.id === s.trigger.tagId)?.name ?? '?'}”`
      : s.trigger.type === 'opted_in'
        ? 'When a contact opts in'
        : 'Manual enrollment';
  return (
    <div className="stack loose">
      {data && data.length > 0 && data.every(q => !q.active) && (
        <Callout tone="success">
          <strong>Ready-made examples, all switched off.</strong> Edit the messages, then switch a sequence on. It starts for a contact when they get
          its tag (for example, add the tag <em>purchased</em> after an order) or when you enroll them yourself.
        </Callout>
      )}
      <Card
        title="Drip sequences"
        subtitle="A series of messages spaced out over time: onboarding, follow-ups, reminders."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setEditing('new')}>
            New sequence
          </Button>
        }
        bodyClass=""
      >
        <ErrorNote error={error} />
        {loading && !data ? (
          <Loading />
        ) : data?.length === 0 ? (
          <Empty title="No sequences yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Create a sequence</Button>}>
            Example: when someone is tagged “new-lead”, send a welcome now, the catalogue after 1 day, and a check-in after 3 days.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sequence</th>
                  <th>Starts</th>
                  <th className="num">Messages</th>
                  <th className="num">In progress</th>
                  <th className="num">Finished</th>
                  <th>Active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.map(s => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                      <div className="small muted">over {formatDuration(s.steps.reduce((sum, x) => sum + x.delayMinutes, 0))}</div>
                    </td>
                    <td className="secondary">{triggerText(s)}</td>
                    <td className="num">{s.steps.length}</td>
                    <td className="num">
                      <button type="button" className="link-button" onClick={() => setViewing(s)}>
                        {formatNumber(s.counts.active)}
                      </button>
                    </td>
                    <td className="num">
                      {formatNumber(s.counts.completed)}
                      {s.counts.stopped > 0 && <div className="small muted">{formatNumber(s.counts.stopped)} stopped</div>}
                    </td>
                    <td>
                      <Toggle
                        checked={s.active}
                        label={<span className="sr-only">Active</span>}
                        onChange={async active => {
                          try {
                            await patch(`/api/sequences/${s.id}`, { ...s, active });
                            void reload();
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      />
                    </td>
                    <td className="right nowrap">
                      <Button size="sm" onClick={() => setViewing(s)}>
                        Contacts
                      </Button>{' '}
                      <Button size="sm" onClick={() => setEditing(s)}>
                        Edit
                      </Button>{' '}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconTrash size={15} />}
                        aria-label="Delete sequence"
                        onClick={async () => {
                          if (await confirm(`Delete “${s.name}”?`, 'Everyone still in it stops receiving its messages.', { confirmLabel: 'Delete', danger: true })) {
                            await del(`/api/sequences/${s.id}`);
                            void reload();
                          }
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <SequenceEditor sequence={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      {viewing && <EnrollmentsModal sequence={viewing} onClose={() => setViewing(null)} />}
      {dialog}
    </div>
  );
}

export function AutomationsPage() {
  const [tab, setTab] = useState<'replies' | 'sequences'>('replies');
  return (
    <div className="page">
      <PageHeader title="Automations" description="Replies and follow-ups that run on their own, around the clock." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'replies', label: 'Auto-replies' },
          { value: 'sequences', label: 'Drip sequences' },
        ]}
      />
      {tab === 'replies' ? <AutoRepliesTab /> : <SequencesTab />}
    </div>
  );
}
