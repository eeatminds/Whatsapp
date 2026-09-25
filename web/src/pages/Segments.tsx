import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, patch, post, useApi, errorMessage, type Rules, type Segment } from '../api';
import { Button, Card, Empty, ErrorNote, Field, Loading, Modal, PageHeader, useConfirm, useToast } from '../components/ui';
import { IconEdit, IconMegaphone, IconPlus, IconTrash } from '../components/icons';
import { RuleBuilder, completeRules } from '../components/pickers';
import { displayName, formatNumber } from '../format';

function describeRules(rules: Rules): string {
  if (rules.conditions.length === 0) return 'Everyone';
  return `${rules.conditions.length} condition${rules.conditions.length === 1 ? '' : 's'}, match ${rules.match}`;
}

function SegmentEditor({ segment, onClose, onSaved }: { segment: Segment | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(segment?.name ?? '');
  const [description, setDescription] = useState(segment?.description ?? '');
  const [rules, setRules] = useState<Rules>(segment?.rules ?? { match: 'all', conditions: [] });
  const [preview, setPreview] = useState<{ count: number; sample: Array<{ id: number; name: string | null; phone: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      post<typeof preview & object>('/api/segments/preview', { rules: completeRules(rules) })
        .then(setPreview)
        .catch(err => setError(errorMessage(err)));
    }, 300);
    return () => clearTimeout(timer);
  }, [rules]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, description: description || null, rules: completeRules(rules) };
      if (segment) await patch(`/api/segments/${segment.id}`, body);
      else await post('/api/segments', body);
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
      title={segment ? 'Edit segment' : 'New segment'}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="secondary" style={{ marginRight: 'auto' }}>
            {preview ? `${formatNumber(preview.count)} contacts match right now` : 'Counting…'}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            Save segment
          </Button>
        </>
      }
    >
      <ErrorNote error={error} />
      <div className="grid cols-2">
        <Field label="Name">
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Pune VIPs active this month" />
        </Field>
        <Field label="Description (optional)">
          <input className="input" value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
      </div>
      <RuleBuilder rules={rules} onChange={setRules} />
      <p className="hint">
        Segments are live: they are re-evaluated every time you use them, so new contacts who match are included automatically. Retarget with “Campaign engagement”, e.g. people who read
        last week's offer but didn't reply.
      </p>
      {preview && preview.sample.length > 0 && (
        <div className="row wrap small secondary">
          Includes:
          {preview.sample.map(c => (
            <span key={c.id} className="tag-chip">
              {displayName(c)}
            </span>
          ))}
          {preview.count > preview.sample.length && <span>and {formatNumber(preview.count - preview.sample.length)} more</span>}
        </div>
      )}
    </Modal>
  );
}

export function SegmentsPage() {
  const { data, error, loading, reload } = useApi<Segment[]>('/api/segments');
  const [editing, setEditing] = useState<Segment | 'new' | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  return (
    <div className="page">
      <PageHeader
        title="Segments"
        description="Saved audiences built from tags, custom fields, consent and engagement."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setEditing('new')}>
            New segment
          </Button>
        }
      />
      <ErrorNote error={error} />
      <Card bodyClass="">
        {loading && !data ? (
          <Loading />
        ) : data?.length === 0 ? (
          <Empty title="No segments yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Create a segment</Button>}>
            For example: tagged “vip”, city is Pune, and messaged you in the last 30 days.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Segment</th>
                  <th>Rules</th>
                  <th className="num">Contacts</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.map(s => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                      {s.description && <div className="small secondary">{s.description}</div>}
                    </td>
                    <td className="secondary">{describeRules(s.rules)}</td>
                    <td className="num">{formatNumber(s.count ?? 0)}</td>
                    <td className="right">
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <Button size="sm" icon={<IconMegaphone size={15} />} onClick={() => navigate(`/campaigns/new?segment=${s.id}`)}>
                          Send campaign
                        </Button>
                        <Button size="sm" variant="ghost" icon={<IconEdit size={15} />} aria-label="Edit segment" onClick={() => setEditing(s)} />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<IconTrash size={15} />}
                          aria-label="Delete segment"
                          onClick={async () => {
                            if (!(await confirm(`Delete “${s.name}”?`, 'Contacts are not affected.', { confirmLabel: 'Delete', danger: true }))) return;
                            try {
                              await del(`/api/segments/${s.id}`);
                              void reload();
                            } catch (err) {
                              toast.error(errorMessage(err));
                            }
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <SegmentEditor segment={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      {dialog}
    </div>
  );
}
