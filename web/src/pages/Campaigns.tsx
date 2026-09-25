import { useNavigate } from 'react-router-dom';
import { useApi, type Campaign, type CampaignStatus } from '../api';
import { Badge, Button, Card, Empty, ErrorNote, Loading, PageHeader } from '../components/ui';
import { IconPlus } from '../components/icons';
import { formatDateTime, formatNumber, percent, relativeTime } from '../format';

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const map: Record<CampaignStatus, { label: string; tone?: 'green' | 'blue' | 'amber' | 'red' }> = {
    draft: { label: 'Draft' },
    scheduled: { label: 'Scheduled', tone: 'blue' },
    running: { label: 'Sending', tone: 'green' },
    paused: { label: 'Paused', tone: 'amber' },
    completed: { label: 'Completed' },
    cancelled: { label: 'Cancelled', tone: 'red' },
  };
  const { label, tone } = map[status];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

function progressOf(c: Campaign): number {
  const done = c.stats.total - c.stats.queued - c.stats.sending;
  return c.stats.total ? done / c.stats.total : 0;
}

export function CampaignsPage() {
  const navigate = useNavigate();
  const { data, error, loading } = useApi<Campaign[]>('/api/campaigns', { poll: 10000 });
  return (
    <div className="page">
      <PageHeader
        title="Campaigns"
        description="Broadcasts to a segment, tag or hand-picked list, paced to keep your numbers safe."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => navigate('/campaigns/new')}>
            New campaign
          </Button>
        }
      />
      <ErrorNote error={error} />
      <Card bodyClass="">
        {loading && !data ? (
          <Loading />
        ) : data?.length === 0 ? (
          <Empty title="No campaigns yet" action={<Button variant="primary" onClick={() => navigate('/campaigns/new')}>Create a campaign</Button>}>
            Write a message, pick who gets it, and choose when. You can split-test up to three versions.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th className="num">Recipients</th>
                  <th className="num">Delivered</th>
                  <th className="num">Read</th>
                  <th className="num">Replied</th>
                  <th className="num">Clicked</th>
                </tr>
              </thead>
              <tbody>
                {data?.map(c => (
                  <tr key={c.id} className="clickable" onClick={() => navigate(c.status === 'draft' ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`)}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="small secondary">
                        {c.status === 'scheduled'
                          ? `Starts ${formatDateTime(c.scheduledAt)}`
                          : c.startedAt
                            ? `Started ${relativeTime(c.startedAt)}`
                            : `Created ${relativeTime(c.createdAt)}`}
                        {c.variants.length > 1 ? ` · A/B test (${c.variants.length} versions)` : ''}
                      </div>
                    </td>
                    <td>
                      <CampaignStatusBadge status={c.status} />
                      {c.status === 'running' && c.waitReason && <div className="small muted" style={{ maxWidth: 220 }}>{c.waitReason}</div>}
                    </td>
                    <td style={{ minWidth: 120 }}>
                      {c.stats.total > 0 ? (
                        <div className="stack tight" style={{ gap: 3 }}>
                          <div className="progress">
                            <div style={{ width: `${progressOf(c) * 100}%` }} />
                          </div>
                          <span className="small muted">{Math.round(progressOf(c) * 100)}%</span>
                        </div>
                      ) : (
                        <span className="muted">–</span>
                      )}
                    </td>
                    <td className="num">{formatNumber(c.stats.total)}</td>
                    <td className="num">{percent(c.stats.delivered, c.stats.sent)}</td>
                    <td className="num">{percent(c.stats.read, c.stats.sent)}</td>
                    <td className="num">{percent(c.stats.replied, c.stats.sent)}</td>
                    <td className="num">{percent(c.stats.clicked, c.stats.sent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
