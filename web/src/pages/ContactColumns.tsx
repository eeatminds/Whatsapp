import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, post, useApi, errorMessage, type Contact } from '../api';
import { Button, ConsentBadge, ErrorNote, Loading, Modal, TagChip, WaBadge, useConfirm, useToast } from '../components/ui';
import { formatNumber, relativeTime } from '../format';
import { StagePill } from './Leads';

/** "course_interested" → "Course interested". */
export function fieldLabel(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------- columns

/** Built-in columns; custom fields are `field:<key>`. The contact (name + phone) is always first. */
const STANDARD: Array<{ id: string; label: string }> = [
  { id: 'email', label: 'Email' },
  { id: 'stage', label: 'Lead stage' },
  { id: 'remark', label: 'Lead remark' },
  { id: 'channel', label: 'Channel' },
  { id: 'tags', label: 'Tags' },
  { id: 'consent', label: 'Consent' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'last_in', label: 'Last message in' },
  { id: 'added', label: 'Added' },
];
const DEFAULT_COLUMNS = ['stage', 'tags', 'consent', 'whatsapp', 'last_in', 'added'];
const STORAGE_KEY = 'wa-reach:contact-columns:v2';
const OLD_STORAGE_KEY = 'wa-reach:contact-columns';
const MAX_COLUMNS = 16;

export function columnLabel(id: string): string {
  return id.startsWith('field:') ? fieldLabel(id.slice(6)) : (STANDARD.find(c => c.id === id)?.label ?? id);
}

function loadColumns(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (Array.isArray(saved)) return saved.filter((c): c is string => typeof c === 'string').slice(0, MAX_COLUMNS);
    // Earlier versions only stored custom fields: keep them, after the tags.
    const old = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY) ?? '[]');
    if (Array.isArray(old) && old.length) {
      const fields = old.filter((k): k is string => typeof k === 'string').map(k => `field:${k}`);
      return [...DEFAULT_COLUMNS.slice(0, 2), ...fields, ...DEFAULT_COLUMNS.slice(2)].slice(0, MAX_COLUMNS);
    }
  } catch {
    // Storage blocked or unreadable: use the defaults.
  }
  return DEFAULT_COLUMNS;
}

/** The columns this person chose, in order, remembered in this browser. */
export function useContactColumns(fieldKeys: string[]) {
  const [columns, setColumns] = useState<string[]>(loadColumns);
  const save = (next: string[]) => {
    setColumns(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private window: the choice lasts for this visit.
    }
  };
  // Hide custom fields that no longer exist (deleted or renamed).
  const visible = columns.filter(id => !id.startsWith('field:') || fieldKeys.includes(id.slice(6)));
  return { columns: visible, setColumns: save, renameField: (from: string, to: string) => save(columns.map(id => (id === `field:${from}` ? `field:${to}` : id))) };
}

export function columnCell(id: string, c: Contact): ReactNode {
  switch (id) {
    case 'email':
      return c.email || <span className="muted">–</span>;
    case 'stage':
      return <StagePill stage={c.leadStage} />;
    case 'remark':
      return c.leadRemark ? <span title={c.leadRemark}>{c.leadRemark}</span> : <span className="muted">–</span>;
    case 'channel':
      return c.channel;
    case 'tags':
      return (
        <div className="row wrap" style={{ gap: 4 }}>
          {c.tags.slice(0, 3).map(t => (
            <TagChip key={t.id} tag={t} />
          ))}
          {c.tags.length > 3 && <span className="small muted">+{c.tags.length - 3}</span>}
        </div>
      );
    case 'consent':
      return <ConsentBadge consent={c.consent} />;
    case 'whatsapp':
      return <WaBadge status={c.waStatus} pending={c.waCheckPending} />;
    case 'last_in':
      return c.lastInboundAt ? relativeTime(c.lastInboundAt) : '–';
    case 'added':
      return relativeTime(c.createdAt);
    default: {
      const value = id.startsWith('field:') ? c.attributes[id.slice(6)] : undefined;
      return value ? <span title={value}>{value}</span> : <span className="muted">–</span>;
    }
  }
}

export function columnClass(id: string): string {
  if (id === 'last_in' || id === 'added') return 'secondary small nowrap';
  if (id === 'channel') return 'secondary small';
  if (id === 'email' || id === 'remark' || id.startsWith('field:')) return 'small cell-clip';
  return '';
}

export function ColumnPicker({
  fieldKeys,
  columns,
  onChange,
  onManageFields,
}: {
  fieldKeys: string[];
  columns: string[];
  onChange: (next: string[]) => void;
  onManageFields: () => void;
}) {
  const available = [...STANDARD.map(c => c.id), ...fieldKeys.map(k => `field:${k}`)].filter(id => !columns.includes(id));
  const ref = useRef<HTMLDetailsElement>(null);
  // Close when clicking anywhere else, like a menu.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  const move = (index: number, by: number) => {
    const next = [...columns];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    onChange(next);
  };
  return (
    <details className="col-picker" ref={ref}>
      <summary className="btn sm">Columns ({columns.length + 1})</summary>
      <div className="col-picker-panel">
        <div className="small muted">Shown, in this order</div>
        <div className="col-row">
          <input type="checkbox" checked disabled aria-label="Contact (always shown)" />
          <span className="grow">Contact (name and phone)</span>
        </div>
        {columns.map((id, i) => (
          <div key={id} className="col-row">
            <input type="checkbox" checked aria-label={`Hide ${columnLabel(id)}`} onChange={() => onChange(columns.filter(c => c !== id))} />
            <span className="grow">{columnLabel(id)}</span>
            <button type="button" className="col-move" disabled={i === 0} aria-label={`Move ${columnLabel(id)} left`} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button type="button" className="col-move" disabled={i === columns.length - 1} aria-label={`Move ${columnLabel(id)} right`} onClick={() => move(i, 1)}>
              ↓
            </button>
          </div>
        ))}
        {available.length > 0 && (
          <>
            <div className="small muted" style={{ marginTop: 10 }}>
              More columns{fieldKeys.length ? ' (custom fields are at the end)' : ''}
            </div>
            {available.map(id => (
              <label key={id} className="col-row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={false} disabled={columns.length >= MAX_COLUMNS} onChange={() => onChange([...columns, id])} />
                <span className="grow">{columnLabel(id)}</span>
              </label>
            ))}
          </>
        )}
        <div className="row between" style={{ marginTop: 10 }}>
          <button type="button" className="link-button" onClick={() => onChange(DEFAULT_COLUMNS)}>
            Reset
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              if (ref.current) ref.current.open = false;
              onManageFields();
            }}
          >
            Manage custom fields…
          </button>
        </div>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- managing custom fields

interface FieldRule {
  target: 'rename' | 'name' | 'email' | 'ignore';
  renameTo: string | null;
}

function ruleText(key: string, rule: FieldRule): string {
  if (rule.target === 'rename') return `“${fieldLabel(key)}” is saved as “${fieldLabel(rule.renameTo ?? '')}”`;
  if (rule.target === 'name') return `“${fieldLabel(key)}” goes into the Name`;
  if (rule.target === 'email') return `“${fieldLabel(key)}” goes into the Email`;
  return `“${fieldLabel(key)}” is not saved`;
}

export function ManageFieldsModal({ onClose, onChanged, onRenamed }: { onClose: () => void; onChanged: () => void; onRenamed: (from: string, to: string) => void }) {
  const { data, error, loading, reload } = useApi<{ fields: Array<{ key: string; count: number }>; rules: Record<string, FieldRule> }>('/api/contacts/fields');
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    try {
      toast.success(await action());
      setEditing(null);
      await reload();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const rename = (from: string) =>
    run(from, async () => {
      const r = await post<{ renamed: number }>('/api/contacts/fields/rename', { from, to: newName });
      const to = newName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
      onRenamed(from, to);
      return `Renamed for ${formatNumber(r.renamed)} contact${r.renamed === 1 ? '' : 's'}. Messages and segments now use {{${to}}}.`;
    });

  const moveTo = (from: string, to: 'name' | 'email') =>
    run(from, async () => {
      const r = await post<{ moved: number; left: number }>('/api/contacts/fields/move', { from, to });
      return `${formatNumber(r.moved)} contact${r.moved === 1 ? '' : 's'} got their ${to} from it.${r.left ? ` ${formatNumber(r.left)} already had one and keep the field.` : ''}`;
    });

  const rules = Object.entries(data?.rules ?? {});
  return (
    <Modal wide title="Custom fields" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="stack">
        <p className="secondary small">
          Changes apply to every contact, and to leads and imports from now on. Renaming also updates saved messages and segments that use the field.
        </p>
        <ErrorNote error={error} />
        {loading && !data ? (
          <Loading />
        ) : data && data.fields.length === 0 ? (
          <p className="secondary">No custom fields yet. They appear when leads or imports bring in extra columns.</p>
        ) : (
          data && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th className="num">Contacts</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {data.fields.map(f => (
                    <tr key={f.key}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{fieldLabel(f.key)}</div>
                        <code className="small">{`{{${f.key}}}`}</code>
                      </td>
                      <td className="num">{formatNumber(f.count)}</td>
                      <td>
                        {editing === f.key ? (
                          <div className="row wrap">
                            <input
                              className="input sm"
                              style={{ width: 180 }}
                              autoFocus
                              value={newName}
                              placeholder="New name, e.g. Pincode"
                              onChange={e => setNewName(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && newName.trim()) void rename(f.key);
                                if (e.key === 'Escape') setEditing(null);
                              }}
                            />
                            <Button size="sm" variant="primary" loading={busy === f.key} disabled={!newName.trim()} onClick={() => void rename(f.key)}>
                              Rename
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="row wrap" style={{ gap: 6 }}>
                            <Button
                              size="sm"
                              onClick={() => {
                                setEditing(f.key);
                                setNewName(fieldLabel(f.key));
                              }}
                            >
                              Rename
                            </Button>
                            <Button size="sm" disabled={busy !== null} onClick={() => void moveTo(f.key, 'name')}>
                              Use as Name
                            </Button>
                            <Button size="sm" disabled={busy !== null} onClick={() => void moveTo(f.key, 'email')}>
                              Use as Email
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={async () => {
                                if (
                                  await confirm(`Delete “${fieldLabel(f.key)}”?`, `It is removed from ${formatNumber(f.count)} contact${f.count === 1 ? '' : 's'}, and new leads stop saving it. This cannot be undone.`, {
                                    confirmLabel: 'Delete field',
                                    danger: true,
                                  })
                                ) {
                                  await run(f.key, async () => {
                                    const r = await post<{ removed: number }>('/api/contacts/fields/delete', { key: f.key });
                                    return `Removed from ${formatNumber(r.removed)} contact${r.removed === 1 ? '' : 's'}`;
                                  });
                                }
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        {rules.length > 0 && (
          <div className="stack tight">
            <span className="label">For new leads and imports</span>
            {rules.map(([key, rule]) => (
              <div key={key} className="row between field-rule">
                <span className="small">{ruleText(key, rule)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(key, async () => {
                      await api('DELETE', `/api/contacts/fields/rules/${key}`);
                      return 'Removed. New leads keep this column as it comes.';
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
      {dialog}
    </Modal>
  );
}
