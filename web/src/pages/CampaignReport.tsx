import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, post, useApi, errorMessage, type Campaign, type CampaignReport, type Settings } from '../api';
import { Badge, Button, Callout, Card, Empty, ErrorNote, Loading, PageHeader, Pagination, StatTile, Tabs, useConfirm, useToast } from '../components/ui';
import { IconArrowLeft, IconCopy, IconDownload, IconEdit, IconPause, IconPlay, IconX } from '../components/icons';
import { ColumnChart, Funnel } from '../components/charts';
import { MessagePreview } from '../components/composer';
import { CampaignStatusBadge } from './Campaigns';
import { formatDateTime, formatDuration, formatNumber, formatPhone, percent } from '../format';

type RecipientStatus = '' | 'queued' | 'sent' | 'delivered' | 'read' | 'replied' | 'clicked' | 'opted_out' | 'failed' | 'skipped' | 'unknown';

interface RecipientPage {
  total: number;
  page: number;
  pageSize: number;
  items: Array<{
    id: number;
    contactId: number;
    name: string | null;
    phone: string;
    variant: string;
    status: string;
    error: string | null;
    sentAt: string | null;
    readAt: string | null;
    repliedAt: string | null;
    clickedAt: string | null;
  }>;
}

const RECIPIENT_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | undefined> = {
  read: 'green',
  delivered: 'blue',
  sent: undefined,
  queued: undefined,
  sending: 'blue',
  failed: 'red',
  skipped: 'amber',
  unknown: 'amber',
};

function hourLabel(iso: string, long = false): string {
  const d = new Date(iso);
  return long ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function CampaignReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const { data, error, loading, reload } = useApi<CampaignReport>(`/api/campaigns/${id}/report`, { poll: 5000 });
  const [status, setStatus] = useState<RecipientStatus>('');
  const [page, setPage] = useState(1);
  const recipients = useApi<RecipientPage>(`/api/campaigns/${id}/recipients?${new URLSearchParams({ ...(status ? { status } : {}), page: String(page), pageSize: '25' })}`, {
    poll: data?.campaign.status === 'running' ? 8000 : undefined,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const { data: settings } = useApi<Settings>('/api/settings');
  const optOutFooter = settings?.compliance.optOutFooter ?? null;

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorNote error={error ?? 'Campaign not found'} />;
  const { campaign } = data;
  const s = campaign.stats;

  const act = async (label: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(label);
    try {
      await fn();
      toast.success(message);
      void reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const leading =
    data.variants.length > 1
      ? [...data.variants].sort((a, b) => b.replied / Math.max(b.sent, 1) - a.replied / Math.max(a.sent, 1) || b.read / Math.max(b.sent, 1) - a.read / Math.max(a.sent, 1))[0]
      : null;

  return (
    <div className="page">
      <PageHeader
        back={
          <Link to="/campaigns" className="row small">
            <IconArrowLeft size={14} /> Campaigns
          </Link>
        }
        title={
          <span className="row wrap">
            {campaign.name} <CampaignStatusBadge status={campaign.status} />
          </span>
        }
        description={
          campaign.status === 'scheduled'
            ? `Scheduled for ${formatDateTime(campaign.scheduledAt)}`
            : campaign.startedAt
              ? `Started ${formatDateTime(campaign.startedAt)}${campaign.completedAt ? ` · finished ${formatDateTime(campaign.completedAt)}` : ''}`
              : undefined
        }
        actions={
          <>
            {campaign.status === 'running' && (
              <Button icon={<IconPause size={16} />} loading={busy === 'pause'} onClick={() => act('pause', () => post(`/api/campaigns/${campaign.id}/pause`), 'Campaign paused')}>
                Pause
              </Button>
            )}
            {campaign.status === 'paused' && (
              <>
                <Button icon={<IconEdit size={16} />} onClick={() => navigate(`/campaigns/${campaign.id}/edit`)}>
                  Edit
                </Button>
                <Button variant="primary" icon={<IconPlay size={16} />} loading={busy === 'resume'} onClick={() => act('resume', () => post(`/api/campaigns/${campaign.id}/resume`), 'Campaign resumed')}>
                  Resume
                </Button>
              </>
            )}
            {campaign.status === 'scheduled' && (
              <Button icon={<IconEdit size={16} />} onClick={() => navigate(`/campaigns/${campaign.id}/edit`)}>
                Edit
              </Button>
            )}
            {['running', 'paused', 'scheduled'].includes(campaign.status) && (
              <Button
                variant="danger"
                icon={<IconX size={16} />}
                onClick={async () => {
                  if (await confirm('Cancel this campaign?', 'Messages already sent stay sent; everyone still queued is skipped. This cannot be undone.', { confirmLabel: 'Cancel campaign', danger: true })) {
                    await act('cancel', () => post(`/api/campaigns/${campaign.id}/cancel`), 'Campaign cancelled');
                  }
                }}
              >
                Cancel
              </Button>
            )}
            <Button
              icon={<IconCopy size={16} />}
              onClick={async () => {
                try {
                  const copy = await post<Campaign>(`/api/campaigns/${campaign.id}/duplicate`);
                  navigate(`/campaigns/${copy.id}/edit`);
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            >
              Duplicate
            </Button>
            <Button icon={<IconDownload size={16} />} onClick={() => (window.location.href = `/api/campaigns/${campaign.id}/recipients.csv`)}>
              Export
            </Button>
            {['completed', 'cancelled'].includes(campaign.status) && (
              <Button
                variant="danger"
                onClick={async () => {
                  if (await confirm('Delete this campaign?', 'Its report and recipient history are removed.', { confirmLabel: 'Delete', danger: true })) {
                    await del(`/api/campaigns/${campaign.id}`);
                    navigate('/campaigns');
                  }
                }}
              >
                Delete
              </Button>
            )}
          </>
        }
      />
      <ErrorNote error={error} />
      {campaign.status === 'paused' && campaign.pausedReason && <Callout tone="warn">{campaign.pausedReason}</Callout>}
      {campaign.status === 'running' && data.waitReason && <Callout tone="warn">Waiting: {data.waitReason}</Callout>}
      {campaign.status === 'running' && data.estimate && !data.waitReason && (
        <Callout>
          {formatNumber(data.estimate.remaining)} messages left, about {formatDuration(data.estimate.minutes)} at the current pace.
        </Callout>
      )}

      <div className="grid cols-4">
        <StatTile label="Recipients" value={formatNumber(s.total)} sub={`${formatNumber(s.sent)} sent · ${formatNumber(s.queued + s.sending)} waiting`} />
        <StatTile label="Read rate" value={percent(s.read, s.sent)} sub={`${formatNumber(s.read)} read · ${percent(s.delivered, s.sent)} delivered`} />
        <StatTile label="Reply rate" value={percent(s.replied, s.sent)} sub={`${formatNumber(s.replied)} replied`} />
        <StatTile
          label={data.trackingEnabled ? 'Click rate' : 'Unsubscribed'}
          value={data.trackingEnabled ? percent(s.clicked, s.sent) : formatNumber(s.optedOut)}
          sub={data.trackingEnabled ? `${formatNumber(s.clicked)} clicked · ${formatNumber(s.optedOut)} unsubscribed` : `${percent(s.optedOut, s.sent, 1)} of recipients`}
        />
      </div>

      <div className="grid cols-2">
        <Card title="Funnel">
          <Funnel
            stages={[
              { label: 'Sent', value: s.sent },
              { label: 'Delivered', value: s.delivered },
              { label: 'Read', value: s.read },
              { label: 'Replied', value: s.replied },
              ...(data.trackingEnabled ? [{ label: 'Clicked', value: s.clicked }] : []),
            ]}
          />
          {(s.failed > 0 || s.skipped > 0 || s.unknown > 0) && (
            <div className="stack tight" style={{ marginTop: 16 }}>
              {data.skipReasons.map(r => (
                <div key={r.reason} className="row between small">
                  <span className="secondary">Skipped: {r.label}</span>
                  <span className="num">{formatNumber(r.count)}</span>
                </div>
              ))}
              {data.failureReasons.map(r => (
                <div key={r.reason} className="row between small">
                  <span className="error-text" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    Failed: {r.reason}
                  </span>
                  <span className="num">{formatNumber(r.count)}</span>
                </div>
              ))}
              {s.unknown > 0 && (
                <div className="row between small">
                  <span className="secondary">Interrupted by a restart (not retried)</span>
                  <span className="num">{formatNumber(s.unknown)}</span>
                </div>
              )}
            </div>
          )}
        </Card>
        <Card title="Sends over time" subtitle="Messages sent per hour, in your browser's time zone">
          {data.timeline.length === 0 ? (
            <p className="muted">Nothing sent yet.</p>
          ) : (
            <ColumnChart data={data.timeline} categoryKey="hour" series={[{ key: 'sent', label: 'Sent', color: 'var(--viz-series-1)' }]} formatCategory={hourLabel} height={200} />
          )}
        </Card>
      </div>

      {data.variants.length > 1 && (
        <Card title="A/B test results" subtitle="Leading version is the one with the highest reply rate so far (read rate breaks ties)." bodyClass="">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th className="num">Sent</th>
                  <th className="num">Read</th>
                  <th className="num">Replied</th>
                  <th className="num">Clicked</th>
                  <th className="num">Unsubscribed</th>
                </tr>
              </thead>
              <tbody>
                {data.variants.map(v => (
                  <tr key={v.key}>
                    <td>
                      <strong>Version {v.key}</strong> {leading?.key === v.key && v.sent > 0 && <Badge tone="green">Leading</Badge>}
                    </td>
                    <td className="num">{formatNumber(v.sent)}</td>
                    <td className="num">{percent(v.read, v.sent, 1)}</td>
                    <td className="num">{percent(v.replied, v.sent, 1)}</td>
                    <td className="num">{percent(v.clicked, v.sent, 1)}</td>
                    <td className="num">{percent(v.optedOut, v.sent, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid cols-2">
        <Card title={campaign.variants.length > 1 ? 'Messages' : 'Message'}>
          <div className="stack">
            {campaign.variants.map(v => (
              <div key={v.key} className="stack tight">
                {campaign.variants.length > 1 && <span className="label">Version {v.key}</span>}
                <MessagePreview body={v.body} mediaId={v.mediaId} footer={campaign.options.appendOptOut ? optOutFooter : null} />
              </div>
            ))}
          </div>
        </Card>
        <Card title="Links" subtitle={data.trackingEnabled ? 'Clicks from real people; link-preview bots are ignored.' : 'Set PUBLIC_URL on the server to track clicks.'} bodyClass="">
          {data.links.length === 0 ? (
            <p className="muted" style={{ padding: '16px 20px' }}>
              No tracked links in this campaign.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th className="num">People</th>
                  <th className="num">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {data.links.map(l => (
                  <tr key={l.code}>
                    <td style={{ overflowWrap: 'anywhere' }}>
                      <a href={l.url} target="_blank" rel="noreferrer noopener">
                        {l.url}
                      </a>
                    </td>
                    <td className="num">{formatNumber(l.uniqueClicks)}</td>
                    <td className="num">{formatNumber(l.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Recipients" bodyClass="">
        <div style={{ padding: '0 12px' }}>
          <Tabs
            value={status}
            onChange={v => {
              setStatus(v);
              setPage(1);
            }}
            tabs={[
              { value: '', label: `All (${formatNumber(s.total)})` },
              { value: 'queued', label: `Waiting (${formatNumber(s.queued)})` },
              { value: 'read', label: `Read (${formatNumber(s.read)})` },
              { value: 'replied', label: `Replied (${formatNumber(s.replied)})` },
              ...(data.trackingEnabled ? [{ value: 'clicked' as const, label: `Clicked (${formatNumber(s.clicked)})` }] : []),
              { value: 'opted_out', label: `Unsubscribed (${formatNumber(s.optedOut)})` },
              { value: 'failed', label: `Failed (${formatNumber(s.failed)})` },
              { value: 'skipped', label: `Skipped (${formatNumber(s.skipped)})` },
            ]}
          />
        </div>
        {recipients.data?.items.length === 0 ? (
          <Empty title="Nobody here" />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Contact</th>
                    {campaign.variants.length > 1 && <th>Version</th>}
                    <th>Status</th>
                    <th>Sent</th>
                    <th>Engagement</th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.data?.items.map(r => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/inbox/${r.contactId}`)}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{r.name || formatPhone(r.phone)}</div>
                        {r.name && <div className="small secondary">{formatPhone(r.phone)}</div>}
                      </td>
                      {campaign.variants.length > 1 && <td>{r.variant}</td>}
                      <td>
                        <Badge tone={RECIPIENT_TONE[r.status]}>{r.status}</Badge>
                        {r.error && <div className="small muted" style={{ maxWidth: 280 }}>{r.error}</div>}
                      </td>
                      <td className="small secondary nowrap">{formatDateTime(r.sentAt)}</td>
                      <td className="small">
                        <div className="row wrap" style={{ gap: 4 }}>
                          {r.repliedAt && <Badge tone="green">Replied</Badge>}
                          {r.clickedAt && <Badge tone="blue">Clicked</Badge>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {recipients.data && <Pagination page={recipients.data.page} pageSize={recipients.data.pageSize} total={recipients.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
      {dialog}
    </div>
  );
}
