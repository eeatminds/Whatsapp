import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { del, post, useApi, errorMessage, type MetaTemplate } from '../api';
import { Button, Callout, Card, Empty, ErrorNote, Loading, Segmented, useConfirm, useToast } from '../components/ui';
import { IconCopy, IconEdit, IconPlus, IconRefresh, IconSearch, IconTrash } from '../components/icons';
import { useSessions } from '../components/pickers';
import { StatusBadges, TemplatePreview, previewOfTemplate, rejectionHelp, templateStatus } from '../components/meta-templates';
import { relativeTime } from '../format';

type Filter = 'all' | 'approved' | 'review' | 'rejected' | 'draft' | 'other';

const inFilter = (t: MetaTemplate, filter: Filter): boolean => {
  switch (filter) {
    case 'approved':
      return t.status === 'APPROVED';
    case 'review':
      return t.status === 'PENDING' || t.status === 'IN_APPEAL';
    case 'rejected':
      return t.status === 'REJECTED';
    case 'draft':
      return t.status === 'DRAFT';
    case 'other':
      return ['PAUSED', 'DISABLED', 'ARCHIVED', 'PENDING_DELETION'].includes(t.status);
    default:
      return true;
  }
};

const CATEGORY_LABEL: Record<string, string> = { MARKETING: 'Marketing', UTILITY: 'Utility', AUTHENTICATION: 'Authentication' };

function TemplateCard({ template, numberId, onChanged }: { template: MetaTemplate; numberId: string; onChanged: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const status = templateStatus(template.status);
  const help = template.status === 'REJECTED' ? rejectionHelp(template.rejectedReason) : null;
  const base = `/templates/meta/${encodeURIComponent(numberId)}`;
  return (
    <Card
      title={<span className="mono">{template.name}</span>}
      subtitle={
        <span>
          {CATEGORY_LABEL[template.category?.toUpperCase() ?? ''] ?? template.category ?? ''} · {template.language}
          {template.updatedAt ? ` · ${relativeTime(template.updatedAt)}` : ''}
        </span>
      }
      actions={<StatusBadges template={template} />}
      footer={
        <div className="row wrap" style={{ gap: 6 }}>
          {template.canEdit && (
            <Button size="sm" icon={<IconEdit size={14} />} onClick={() => navigate(`${base}/${template.id}`)}>
              {template.status === 'DRAFT' ? 'Continue editing' : template.status === 'REJECTED' ? 'Fix and resubmit' : 'Edit'}
            </Button>
          )}
          <Button size="sm" icon={<IconCopy size={14} />} onClick={() => navigate(`${base}/new?from=${template.id}&as=language`)}>
            Add language
          </Button>
          <Button size="sm" onClick={() => navigate(`${base}/new?from=${template.id}&as=copy`)}>
            Duplicate
          </Button>
          <span className="spacer" />
          {template.status !== 'DISABLED' && (
            <Button
              size="sm"
              variant="danger"
              icon={<IconTrash size={14} />}
              aria-label={`Delete ${template.name}`}
              onClick={async () => {
                const inMeta = template.status !== 'DRAFT';
                const ok = await confirm(
                  `Delete “${template.name}” (${template.language})?`,
                  inMeta
                    ? 'It is deleted in Meta too. Campaigns using it stop sending, and Meta does not allow a new template with this name for 30 days.'
                    : 'This draft is only in WA Reach.',
                  { confirmLabel: 'Delete', danger: true },
                );
                if (!ok) return;
                try {
                  await del(`/api/official/numbers/${encodeURIComponent(numberId)}/templates/${template.id}`);
                  toast.success('Template deleted');
                  onChanged();
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            />
          )}
        </div>
      }
    >
      <div className="stack">
        <TemplatePreview model={previewOfTemplate(template, template.examples, { header: template.exampleMedia?.header, cards: template.exampleMedia?.cards })} />
        {status.meaning && template.status !== 'APPROVED' && <p className="small secondary" style={{ margin: 0 }}>{status.meaning}</p>}
        {help && (
          <Callout tone="danger">
            <strong>{help.why}</strong> {template.statusNote ? <span>{template.statusNote} </span> : null}
            {help.fix}
          </Callout>
        )}
        {!help && template.statusNote && <Callout tone="warn">{template.statusNote}</Callout>}
        {template.status === 'APPROVED' && !template.supported && template.reason && <p className="small error-text">{template.reason}</p>}
      </div>
      {dialog}
    </Card>
  );
}

/** Templates approved by Meta for official numbers: made, tracked and edited here. */
export function MetaTemplatesTab() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: sessions } = useSessions();
  const numbers = (sessions?.items ?? []).filter(s => s.channel === 'official');
  const numberId = params.get('number') ?? numbers[0]?.id ?? null;
  const { data, error, loading, reload, setData } = useApi<{ items: MetaTemplate[] }>(
    numberId ? `/api/official/numbers/${encodeURIComponent(numberId)}/templates` : null,
    { poll: 30_000 },
  );
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [syncing, setSyncing] = useState(false);
  const items = data?.items ?? [];
  const count = (f: Filter) => items.filter(t => inFilter(t, f)).length;
  const shown = useMemo(
    () => items.filter(t => inFilter(t, filter) && (!q.trim() || `${t.name} ${t.bodyText}`.toLowerCase().includes(q.trim().toLowerCase()))),
    [items, filter, q],
  );

  if (sessions && numbers.length === 0) {
    return (
      <Card>
        <Empty
          title="Templates need an official WhatsApp number"
          action={
            <Link className="btn primary" to="/numbers">
              Connect an official number
            </Link>
          }
        >
          Meta-approved templates are how official (Cloud API) numbers start conversations. Numbers linked by QR code send your saved messages instead.
        </Empty>
      </Card>
    );
  }
  if (!numberId) return <Loading />;

  return (
    <div className="stack">
      <div className="row between wrap" style={{ gap: 10 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          {numbers.length > 1 && (
            <select className="select sm" style={{ width: 'auto' }} value={numberId} onChange={e => setParams({ tab: 'meta', number: e.target.value })} aria-label="WhatsApp number">
              {numbers.map(n => (
                <option key={n.id} value={n.id}>
                  {n.name}
                  {n.phone ? ` · +${n.phone}` : ''}
                </option>
              ))}
            </select>
          )}
          <div className="row" style={{ position: 'relative', minWidth: 200 }}>
            <IconSearch size={16} style={{ position: 'absolute', left: 10, color: 'var(--text-muted)' }} />
            <input className="input sm" style={{ paddingLeft: 32 }} placeholder="Search templates" value={q} onChange={e => setQ(e.target.value)} aria-label="Search templates" />
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button
            icon={<IconRefresh size={16} />}
            loading={syncing}
            onClick={async () => {
              setSyncing(true);
              try {
                setData(await post<{ items: MetaTemplate[] }>(`/api/official/numbers/${encodeURIComponent(numberId)}/sync-templates`));
                toast.success('Templates and their statuses are up to date');
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setSyncing(false);
              }
            }}
          >
            Sync from Meta
          </Button>
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => navigate(`/templates/meta/${encodeURIComponent(numberId)}/new`)}>
            Create template
          </Button>
        </div>
      </div>
      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: `All (${items.length})` },
          { value: 'approved', label: `Approved (${count('approved')})` },
          { value: 'review', label: `In review (${count('review')})` },
          { value: 'rejected', label: `Rejected (${count('rejected')})` },
          { value: 'draft', label: `Drafts (${count('draft')})` },
          ...(count('other') ? [{ value: 'other' as const, label: `Paused or disabled (${count('other')})` }] : []),
        ]}
      />
      <ErrorNote error={error} />
      {loading && !data ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <Empty
            title="No templates yet"
            action={
              <Button variant="primary" onClick={() => navigate(`/templates/meta/${encodeURIComponent(numberId)}/new`)}>
                Create your first template
              </Button>
            }
          >
            Write the message, add a photo and buttons, and send it to Meta for approval, all from here. Approval usually takes a few minutes.
          </Empty>
        </Card>
      ) : shown.length === 0 ? (
        <p className="muted">No templates match.</p>
      ) : (
        <div className="grid cols-3 tpl-grid">
          {shown.map(t => (
            <TemplateCard key={t.id} template={t} numberId={numberId} onChanged={() => void reload()} />
          ))}
        </div>
      )}
    </div>
  );
}
