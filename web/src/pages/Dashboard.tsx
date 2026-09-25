import { Link, useNavigate } from 'react-router-dom';
import { useApi, type Campaign, type Overview } from '../api';
import { Badge, Button, Callout, Card, ErrorNote, Loading, PageHeader, StatTile } from '../components/ui';
import { ColumnChart, Funnel } from '../components/charts';
import { IconPlus } from '../components/icons';
import { formatNumber, percent, plural } from '../format';
import { CampaignStatusBadge } from './Campaigns';

function dayLabel(date: string, long = false): string {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, error, loading } = useApi<Overview>('/api/overview', { poll: 30000 });
  const { data: campaigns } = useApi<Campaign[]>('/api/campaigns');

  if (loading && !data) return <Loading />;
  const readyNumbers = data?.sessions.filter(s => s.status === 'ready') ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description="How your WhatsApp marketing is performing."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => navigate('/campaigns/new')}>
            New campaign
          </Button>
        }
      />
      <ErrorNote error={error} />
      {data && !data.gateway.reachable && (
        <Callout tone="danger">
          The WhatsApp gateway is unreachable{data.gateway.lastError ? `: ${data.gateway.lastError}` : ''}. Nothing can be sent until it is back.{' '}
          <Link to="/settings">Check the connection</Link>
        </Callout>
      )}
      {data && data.gateway.reachable && readyNumbers.length === 0 && (
        <Callout tone="warn">
          No WhatsApp number is connected yet. <Link to="/numbers">Connect a number</Link> to start sending.
        </Callout>
      )}
      {data && data.contacts.total === 0 && (
        <Callout>
          Your audience is empty. <Link to="/contacts">Import contacts from a spreadsheet</Link> or let them opt in by messaging your number.
        </Callout>
      )}

      {data && (
        <>
          <div className="grid cols-4">
            <StatTile
              label="Contacts"
              value={formatNumber(data.contacts.total)}
              sub={`${formatNumber(data.contacts.optedIn)} opted in · ${formatNumber(data.contacts.optedOut)} opted out`}
            />
            <StatTile
              label="Marketing sent today"
              value={formatNumber(data.today.marketingSent)}
              sub={`Limit ${formatNumber(data.dailyCap)} per number per day`}
            />
            <StatTile label="Messages received today" value={formatNumber(data.today.received)} sub={`${formatNumber(data.contacts.newLast7Days)} new contacts this week`} />
            <StatTile
              label="Unread conversations"
              value={formatNumber(data.unreadConversations)}
              sub={
                data.unreadConversations > 0 ? (
                  <Link to="/inbox">Open inbox</Link>
                ) : (
                  'All caught up'
                )
              }
            />
          </div>

          <div className="grid cols-2">
            <Card title="Messages, last 14 days" subtitle="Everything sent from and received on your numbers">
              <ColumnChart
                data={data.series}
                categoryKey="date"
                series={[
                  { key: 'sent', label: 'Sent', color: 'var(--viz-series-1)' },
                  { key: 'received', label: 'Received', color: 'var(--viz-series-2)' },
                ]}
                formatCategory={dayLabel}
              />
            </Card>
            <Card title="Campaign funnel, last 30 days" subtitle={`${formatNumber(data.funnel30d.optedOut)} unsubscribed after a campaign (${percent(data.funnel30d.optedOut, data.funnel30d.sent, 1)})`}>
              <Funnel
                stages={[
                  { label: 'Sent', value: data.funnel30d.sent },
                  { label: 'Delivered', value: data.funnel30d.delivered },
                  { label: 'Read', value: data.funnel30d.read },
                  { label: 'Replied', value: data.funnel30d.replied },
                  { label: 'Clicked', value: data.funnel30d.clicked },
                ]}
              />
            </Card>
          </div>

          <div className="grid sidebar-right">
            <Card
              title="Recent campaigns"
              actions={<Link to="/campaigns">View all</Link>}
              bodyClass=""
            >
              {campaigns && campaigns.length === 0 ? (
                <div className="empty">
                  <p>No campaigns yet.</p>
                  <Button variant="primary" onClick={() => navigate('/campaigns/new')}>
                    Create your first campaign
                  </Button>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>Status</th>
                        <th className="num">Sent</th>
                        <th className="num">Read</th>
                        <th className="num">Replied</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaigns?.slice(0, 6).map(c => (
                        <tr key={c.id} className="clickable" onClick={() => navigate(c.status === 'draft' ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`)}>
                          <td>
                            <strong>{c.name}</strong>
                          </td>
                          <td>
                            <CampaignStatusBadge status={c.status} />
                          </td>
                          <td className="num">{formatNumber(c.stats.sent)}</td>
                          <td className="num">{percent(c.stats.read, c.stats.sent)}</td>
                          <td className="num">{percent(c.stats.replied, c.stats.sent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card title="Right now">
              <dl className="kv">
                <dt>Running</dt>
                <dd>{plural(data.campaigns.running, 'campaign')}</dd>
                <dt>Scheduled</dt>
                <dd>{plural(data.campaigns.scheduled, 'campaign')}</dd>
                <dt>Paused</dt>
                <dd>{data.campaigns.paused ? <Badge tone="amber">{data.campaigns.paused} paused</Badge> : '0'}</dd>
                <dt>In drip sequences</dt>
                <dd>{plural(data.activeDripEnrollments, 'contact')}</dd>
                <dt>Numbers</dt>
                <dd>
                  {data.sessions.length === 0
                    ? 'None'
                    : data.sessions.map(s => (
                        <div key={s.id}>
                          {s.name} <Badge tone={s.status === 'ready' ? 'green' : 'amber'}>{s.status === 'ready' ? 'Connected' : s.status.replace('_', ' ')}</Badge>
                        </div>
                      ))}
                </dd>
              </dl>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
