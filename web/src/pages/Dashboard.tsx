import { useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi, type DashboardData } from '../api';
import { Button, Callout, Card, ErrorNote, Loading, PageHeader, Segmented } from '../components/ui';
import { ColumnChart, Funnel } from '../components/charts';
import { IconDownload, IconInfo } from '../components/icons';
import { formatCallLength, formatNumber, percent, plural } from '../format';
import { memberName } from '../team';

type Preset = 'today' | '7' | '14' | '30' | 'custom';
const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: 'custom', label: 'Choose dates' },
];

function dayLabel(date: string, long = false): string {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
}

/** "the last 14 days", "today", "1 Nov to 18 Nov". */
function periodLabel(preset: Preset, range: DashboardData['range']): string {
  if (preset === 'today') return 'today';
  if (preset !== 'custom') return `the last ${range.days} days`;
  return range.from === range.to ? dayLabel(range.from) : `${dayLabel(range.from)} to ${dayLabel(range.to)}`;
}

/** "▲ 12% vs before", "Same as before", or nothing when there is nothing to compare with. */
function change(now: number, before: number): string | null {
  if (now === before) return before ? 'Same as before' : null;
  if (!before) return `▲ ${formatNumber(now)} more than before`;
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs before`;
}

function Hint({ text }: { text: string }) {
  return (
    <span className="dash-hint" title={text} aria-label={text}>
      <IconInfo size={13} />
    </span>
  );
}

function CardTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      {title} <Hint text={hint} />
    </span>
  );
}

/** A total with a bar split into its parts, each part named and counted (never colour alone). */
function ScoreTile({
  label,
  hint,
  value,
  note,
  parts,
  link,
}: {
  label: string;
  hint: string;
  value: number;
  note?: ReactNode;
  parts: Array<{ label: string; value: number; color: string }>;
  link?: ReactNode;
}) {
  const sum = parts.reduce((n, p) => n + p.value, 0);
  return (
    <div className="card dash-score">
      <div className="dash-score-label">
        {label} <Hint text={hint} />
      </div>
      <div className="dash-score-value">
        {formatNumber(value)}
        {note && <span className="dash-score-note">{note}</span>}
      </div>
      <div className="dash-split" role="img" aria-label={parts.map(p => `${p.label}: ${p.value}`).join(', ')}>
        {sum > 0 ? parts.filter(p => p.value > 0).map(p => <i key={p.label} style={{ flex: p.value, background: p.color }} />) : <i style={{ flex: 1, background: 'var(--surface-sunken)' }} />}
      </div>
      <div className="dash-parts">
        {parts.map(p => (
          <span key={p.label}>
            <i style={{ background: p.color }} />
            {p.label}
            <b>{formatNumber(p.value)}</b>
          </span>
        ))}
      </div>
      {link}
    </div>
  );
}

function Kpi({ label, value, sub, tone = 'meh', help, accent }: { label: string; value: number; sub: ReactNode; tone?: 'good' | 'bad' | 'meh'; help: string; accent?: string }) {
  return (
    <div className="dash-kpi" style={accent ? { borderBottomColor: accent } : undefined}>
      <div className="dash-kpi-label">{label}</div>
      <div className="dash-kpi-value">{formatNumber(value)}</div>
      <div className={`dash-kpi-sub ${tone}`}>{sub}</div>
      <div className="dash-kpi-help">{help}</div>
    </div>
  );
}

function Takeaway({ children }: { children: ReactNode }) {
  return <div className="dash-takeaway">{children}</div>;
}

const CALL_APP: Record<DashboardData['team'][number]['callApp'], { label: string; tone: string }> = {
  working: { label: '✓ Working', tone: 'green' },
  quiet: { label: 'Quiet for a while', tone: 'amber' },
  no_call_access: { label: '! Call history off', tone: 'red' },
  stopped: { label: '! Stopped sending', tone: 'red' },
  none: { label: '! Not set up', tone: 'amber' },
  off: { label: 'Not in the call app', tone: '' },
};

function downloadReport(d: DashboardData) {
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows: Array<Array<string | number>> = [
    ['WA Reach dashboard', `${d.range.from} to ${d.range.to}`],
    [],
    ['WhatsApp messages', 'Count'],
    ['You sent', d.messages.sent],
    ['Delivered', d.messages.delivered],
    ['Read', d.messages.read],
    ['Failed', d.messages.failed],
    ['Customers sent', d.messages.received],
    ['Opted out', d.messages.optedOut],
    [],
    ['Day', 'You sent', 'Delivered', 'Read', 'Customers sent'],
    ...d.messages.series.map(p => [p.date, p.sent, p.delivered, p.read, p.received]),
    [],
    ['Lead source', 'Leads', 'Untouched', 'Warm', 'Cold', 'Closed'],
    ...d.leads.channels.map(c => [c.name, c.leads, c.untouched, c.warm, c.cold, c.closed]),
    [],
    ['Person', 'Leads', 'Calls', 'Picked up', 'Talk time (seconds)', 'Remarks without a call'],
    ...d.team.map(t => [memberName(t), t.leads, t.calls, t.answered, t.talkSeconds, t.remarksWithoutCall]),
  ];
  const blob = new Blob(['﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dashboard-${d.range.from}-to-${d.range.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('range');
  const preset: Preset = PRESETS.some(p => p.value === asked) ? (asked as Preset) : '14';
  const custom = { from: params.get('from') ?? '', to: params.get('to') ?? '' };
  const query = useMemo(() => {
    if (preset === 'custom' && custom.from && custom.to) return `from=${custom.from}&to=${custom.to}`;
    return `days=${preset === 'today' ? 1 : preset === 'custom' ? 14 : preset}`;
  }, [preset, custom.from, custom.to]);
  const { data: d, error, loading } = useApi<DashboardData>(`/api/dashboard?${query}`, { poll: 60_000 });

  const setRange = (next: Preset, from?: string, to?: string) => {
    const p = new URLSearchParams();
    if (next !== '14') p.set('range', next);
    if (next === 'custom') {
      p.set('from', from ?? d?.range.from ?? '');
      p.set('to', to ?? d?.range.to ?? '');
    }
    setParams(p, { replace: true });
  };

  if (loading && !d) return <Loading />;
  const ready = d?.setup.sessions.filter(s => s.status === 'ready') ?? [];

  return (
    <div className="page dash">
      <PageHeader
        title="Dashboard"
        description="Your WhatsApp messages, leads and team at a glance."
        actions={
          <>
            <Segmented value={preset} onChange={v => setRange(v)} options={PRESETS} />
            {preset === 'custom' && (
              <div className="row" style={{ gap: 6 }}>
                <input className="input sm" type="date" value={custom.from} max={custom.to || undefined} onChange={e => setRange('custom', e.target.value, custom.to)} aria-label="From" />
                <span className="muted">to</span>
                <input className="input sm" type="date" value={custom.to} min={custom.from || undefined} onChange={e => setRange('custom', custom.from, e.target.value)} aria-label="To" />
              </div>
            )}
            <Button icon={<IconDownload size={15} />} onClick={() => d && downloadReport(d)} disabled={!d}>
              Download
            </Button>
          </>
        }
      />
      <ErrorNote error={error} />
      {d && !d.gateway.reachable && (
        <Callout tone="danger">
          The WhatsApp gateway is unreachable{d.gateway.lastError ? `: ${d.gateway.lastError}` : ''}. Nothing can be sent until it is back.{' '}
          <Link to="/settings">Check the connection</Link>
        </Callout>
      )}
      {d && d.gateway.reachable && ready.length === 0 && (
        <Callout tone="warn">
          No WhatsApp number is connected yet. <Link to="/numbers">Connect a number</Link> to start sending.
        </Callout>
      )}
      {d && d.contacts.total === 0 && (
        <Callout>
          Your audience is empty. <Link to="/contacts">Import contacts from a spreadsheet</Link> or let them opt in by messaging your number.
        </Callout>
      )}
      {d && <Body d={d} period={periodLabel(preset, d.range)} />}
    </div>
  );
}

function Body({ d, period }: { d: DashboardData; period: string }) {
  const m = d.messages;
  const dates = `range=custom&from=${d.range.from}&to=${d.range.to}`;
  const contacted = d.leads.funnel.find(s => s.key === 'contacted')?.count ?? 0;
  const untouched = d.leads.byStage.untouched;
  const missingApp = d.setup.callApp.callers - d.setup.callApp.connected;
  const busiest = m.series.reduce<DashboardData['messages']['series'][number] | null>((top, p) => (!top || p.received > top.received ? p : top), null);

  const attention: Array<{ text: string; to: string; action: string }> = [];
  if (d.chats.unread) attention.push({ text: plural(d.chats.unread, 'unread chat'), to: '/inbox', action: 'Open Inbox' });
  if (untouched) attention.push({ text: `${plural(untouched, 'lead')} not contacted yet`, to: `/leads?stage=untouched&${dates}`, action: 'Open Leads' });
  if (d.leads.unassignedUntouched && !d.setup.autoAssign) attention.push({ text: `${plural(d.leads.unassignedUntouched, 'new lead')} not given to anyone`, to: `/leads?${dates}`, action: 'Give leads' });
  if (missingApp > 0) attention.push({ text: `${plural(missingApp, 'caller')} without the call app`, to: '/calls', action: 'Open Calls' });
  if (d.setup.phonesNeedingHelp) attention.push({ text: `${plural(d.setup.phonesNeedingHelp, 'phone')} stopped sending calls`, to: '/calls', action: 'Open Calls' });

  const senders = [
    { key: 'inbox', label: 'Replies from the Inbox', help: 'your team, typing', value: m.senders.inbox },
    { key: 'auto', label: 'Auto-replies', help: 'Automations', value: m.senders.autoReply },
    { key: 'phone', label: 'From the phone', help: 'WhatsApp on the phone itself', value: m.senders.phone },
    { key: 'marketing', label: 'Campaigns and drips', help: 'offers to many customers', value: m.senders.marketing },
    ...(m.senders.other ? [{ key: 'other', label: 'Other', help: 'tests and system messages', value: m.senders.other }] : []),
  ];
  // The source whose leads most often get warm or closed (with enough leads to tell).
  const best = d.leads.channels
    .filter(c => c.leads >= 3 && c.warm + c.closed > 0)
    .sort((a, b) => (b.warm + b.closed) / b.leads - (a.warm + a.closed) / a.leads)[0];
  const biggest = d.leads.channels[0];

  return (
    <>
      <p className="dash-summary">
        In {period} customers sent you <b>{plural(m.received, 'WhatsApp message')}</b> and you sent <b>{formatNumber(m.sent)}</b>.{' '}
        {d.leads.total ? (
          <>
            <b>{plural(d.leads.total, 'lead')}</b> came in: <b>{formatNumber(contacted)}</b> {contacted === 1 ? 'was' : 'were'} contacted and{' '}
            <b>{formatNumber(d.leads.byStage.closed)}</b> {d.leads.byStage.closed === 1 ? 'is' : 'are'} closed.
          </>
        ) : (
          'No new leads came in.'
        )}
      </p>

      {attention.length > 0 ? (
        <div className="dash-attention" role="status">
          <b>Needs attention</b>
          {attention.slice(0, 4).map(a => (
            <span key={a.text}>
              {a.text} · <Link to={a.to}>{a.action}</Link>
            </span>
          ))}
        </div>
      ) : (
        <div className="dash-allgood">✓ All caught up: no unread chats, every lead contacted, and every caller's phone connected.</div>
      )}

      <div className="grid cols-4">
        <ScoreTile
          label="Contacts"
          hint="Everyone saved in Contacts. WA Reach checks whether each number has WhatsApp."
          value={d.contacts.total}
          note={d.contacts.added ? `+${formatNumber(d.contacts.added)} in these days` : undefined}
          parts={[
            { label: 'On WhatsApp', value: d.contacts.onWhatsApp, color: 'var(--viz-series-1)' },
            { label: 'Not on WhatsApp', value: d.contacts.notOnWhatsApp, color: 'var(--viz-series-2)' },
            { label: 'Not checked yet', value: d.contacts.unchecked, color: 'var(--border-strong)' },
          ]}
        />
        <ScoreTile
          label="Leads"
          hint="Contacts added in these days, by where they are in the sale."
          value={d.leads.total}
          note={change(d.leads.total, d.leads.before)}
          parts={[
            { label: 'Untouched', value: untouched, color: 'var(--border-strong)' },
            { label: 'Warm or cold', value: d.leads.byStage.warm + d.leads.byStage.cold, color: 'var(--viz-series-1)' },
            { label: 'Closed', value: d.leads.byStage.closed, color: 'var(--stage-closed)' },
          ]}
        />
        <ScoreTile
          label="Chats"
          hint="People who wrote to you in these days. Waiting: the last message in the chat is still theirs."
          value={d.chats.conversations}
          note="people wrote in"
          parts={[
            { label: 'Replied to', value: d.chats.conversations - d.chats.waiting, color: 'var(--viz-series-1)' },
            { label: 'Waiting for your reply', value: d.chats.waiting, color: 'var(--viz-series-2)' },
          ]}
        />
        <ScoreTile
          label="Calls to leads"
          hint="Calls your callers made to leads from their phones, sent by the WA Reach Calls app."
          value={d.calls.calls}
          note={d.calls.talkSeconds ? `${formatCallLength(d.calls.talkSeconds)} talking` : undefined}
          parts={[
            { label: 'Picked up', value: d.calls.answered, color: 'var(--viz-series-1)' },
            { label: 'Not answered', value: d.calls.calls - d.calls.answered, color: 'var(--border-strong)' },
          ]}
          link={
            !d.calls.tracking ? (
              <Link to="/calls" className="small">
                Connect callers' phones →
              </Link>
            ) : undefined
          }
        />
      </div>

      <Card
        title={<CardTitle title="WhatsApp messages" hint="Every message sent from and received on your WhatsApp numbers in these days." />}
        subtitle={`All your numbers together · ${period}`}
        bodyClass=""
      >
        <div className="dash-kpis">
          <Kpi label="You sent" value={m.sent} sub={change(m.sent, m.before.sent) ?? 'all messages out'} help="all messages out" accent="var(--viz-series-1)" />
          <Kpi label="Delivered" value={m.delivered} sub={`${percent(m.delivered, m.sent)} of sent`} tone="good" help="reached their phone" />
          <Kpi label="Read" value={m.read} sub={`${percent(m.read, m.delivered)} of delivered`} tone="good" help="blue ticks" />
          <Kpi label="Failed" value={m.failed} sub={`${percent(m.failed, m.sent)} of sent`} tone={m.failed ? 'bad' : 'meh'} help="didn't reach" />
          <Kpi label="Customers sent" value={m.received} sub={change(m.received, m.before.received) ?? 'messages in'} help="messages in" accent="var(--viz-series-2)" />
          <Kpi label="Opted out" value={m.optedOut} sub={`${formatNumber(m.optedIn)} opted in`} help="said STOP" />
        </div>
        <div className="dash-split-21">
          <div className="card-body">
            <ColumnChart
              data={m.series}
              categoryKey="date"
              series={[
                { key: 'sent', label: 'You sent', color: 'var(--viz-series-1)' },
                { key: 'received', label: 'Customers sent', color: 'var(--viz-series-2)' },
              ]}
              formatCategory={dayLabel}
            />
            {busiest && busiest.received > 0 && (
              <Takeaway>
                <b>Busiest day: {dayLabel(busiest.date)}</b>, when {plural(busiest.received, 'message')} came in.{' '}
                {m.received > m.sent ? 'Customers write more than you send, so replying fast matters.' : 'You send more than customers write.'}
              </Takeaway>
            )}
          </div>
          <div className="card-body dash-list">
            <strong>Who sent your {plural(m.sent, 'message')}</strong>
            {senders.map(s => (
              <div className="dash-list-row" key={s.key}>
                <div>
                  {s.label}
                  <span>
                    {s.help}
                    {s.key === 'marketing' && !s.value && (
                      <>
                        {' · '}
                        <Link to="/campaigns/new">Create one</Link>
                      </>
                    )}
                  </span>
                  <div className="dash-bar">
                    <i style={{ width: `${m.sent ? (s.value / m.sent) * 100 : 0}%` }} />
                  </div>
                </div>
                <b>{formatNumber(s.value)}</b>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid dash-cols-12">
        <Card title={<CardTitle title="Lead funnel" hint="How far the leads added in these days have got. Each step is part of the one before it." />} subtitle={`How far your ${plural(d.leads.total, 'lead')} got`}>
          {d.leads.total ? (
            <>
              <Funnel
                caption="Of all leads"
                baseLabel="Of all leads"
                stages={d.leads.funnel.map(s => ({
                  label: ({ total: 'All leads', contacted: 'Contacted', interested: 'Warm or closed', closed: 'Closed' } as Record<string, string>)[s.key] ?? s.label,
                  value: s.count,
                  hint: ({ total: 'came in', contacted: 'called or messaged', interested: 'showed interest', closed: 'deal done' } as Record<string, string>)[s.key],
                }))}
              />
              <Takeaway>
                {untouched ? (
                  <>
                    <b>{plural(untouched, 'lead was', 'leads were')} never contacted.</b> A call or message to them is the quickest win.
                  </>
                ) : (
                  <b>Every lead has been contacted.</b>
                )}
              </Takeaway>
            </>
          ) : (
            <p className="muted">
              No leads came in {period}. <Link to="/automations?tab=leads">Connect a lead source</Link> to get leads from your website or a Google Sheet.
            </p>
          )}
        </Card>

        <Card
          title={<CardTitle title="Top lead sources" hint="Where the leads added in these days came from, and how they're doing." />}
          subtitle="Where your leads came from, and how they're doing"
          actions={<Link to={`/leads?${dates}`}>Leads →</Link>}
          bodyClass=""
        >
          {d.leads.channels.length === 0 ? (
            <p className="muted" style={{ padding: '16px 20px' }}>
              No leads in these days.
            </p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th className="num">Leads</th>
                      <th className="dash-hide-sm">Share</th>
                      <th className="num">Untouched</th>
                      <th className="num dash-hide-sm">Warm</th>
                      <th className="num">Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.leads.channels.slice(0, 6).map(c => (
                      <tr key={c.key}>
                        <td>
                          <Link to={`/leads?channel=${encodeURIComponent(c.key)}&${dates}`}>
                            <strong>{c.name}</strong>
                          </Link>
                          {best && best.key === c.key && (
                            <span className="badge green" style={{ marginLeft: 6 }}>
                              Best
                            </span>
                          )}
                        </td>
                        <td className="num">{formatNumber(c.leads)}</td>
                        <td className="dash-hide-sm">
                          <div className="dash-share">
                            <div>
                              <i style={{ width: `${(c.leads / d.leads.total) * 100}%` }} />
                            </div>
                            <em>{percent(c.leads, d.leads.total)}</em>
                          </div>
                        </td>
                        <td className="num">{formatNumber(c.untouched)}</td>
                        <td className="num dash-hide-sm">{formatNumber(c.warm)}</td>
                        <td className="num">{formatNumber(c.closed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-body" style={{ paddingTop: 0 }}>
                <Takeaway>
                  <b>{biggest.name} brings the most leads.</b>
                  {best && best.key !== biggest.key && (
                    <>
                      {' '}
                      {best.name} leads warm up most often ({best.warm + best.closed} of {best.leads}).
                    </>
                  )}
                </Takeaway>
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid dash-cols-21">
        <Card
          title={<CardTitle title="Team" hint="Leads added in these days given to each person, and their calls to leads." />}
          subtitle="Leads given to each caller, and their calls"
          actions={<Link to="/calls">Calls →</Link>}
          bodyClass=""
        >
          {d.team.length === 0 ? (
            <p className="muted" style={{ padding: '16px 20px' }}>
              No callers yet. <Link to="/account">Add callers</Link> to share out leads and see their calls here.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th className="num">Leads</th>
                    <th className="num">Calls</th>
                    <th className="num dash-hide-sm">Talking</th>
                    <th className="num dash-hide-sm">Remark, no call</th>
                    <th>Call app</th>
                  </tr>
                </thead>
                <tbody>
                  {d.team.map(t => {
                    const app = CALL_APP[t.callApp];
                    return (
                      <tr key={t.userId}>
                        <td>
                          <strong>{memberName(t)}</strong>
                          {t.role !== 'caller' && <span className="small muted"> · {t.role === 'owner' ? 'Admin' : 'Team member'}</span>}
                          {t.remarksWithoutCall > 0 && <span className="dash-show-sm small error-text">⚠️ {formatNumber(t.remarksWithoutCall)} remark, no call</span>}
                        </td>
                        <td className="num">{formatNumber(t.leads)}</td>
                        <td className="num">
                          {t.calls ? (
                            <>
                              {formatNumber(t.calls)}
                              <span className="dash-sub">{formatNumber(t.answered)} picked up</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="num dash-hide-sm">{t.talkSeconds ? formatCallLength(t.talkSeconds) : '—'}</td>
                        <td className="num dash-hide-sm">
                          {t.remarksWithoutCall ? (
                            <Link to={`/leads?assignee=${t.userId}`} className="error-text">
                              <strong>⚠️ {t.remarksWithoutCall}</strong>
                            </Link>
                          ) : (
                            0
                          )}
                        </td>
                        <td>
                          <span className={`badge ${app.tone}`}>{app.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={<CardTitle title="Set-up check" hint="Whether your numbers, lead sharing and callers' phones are working." />} subtitle="Is everything working?">
          <div className="dash-list">
            {d.setup.sessions.map(s => (
              <div className="dash-list-row" key={s.id}>
                <div>
                  {s.name}
                  <span>WhatsApp number</span>
                </div>
                <span className={`badge ${s.status === 'ready' ? 'green' : 'amber'}`}>{s.status === 'ready' ? '✓ Connected' : s.status.replace('_', ' ')}</span>
              </div>
            ))}
            <div className="dash-list-row">
              <div>
                Offers sent today
                <span>
                  {formatNumber(d.today.marketingSent)} of {formatNumber(d.today.dailyCap)} per number
                </span>
                <div className="dash-bar">
                  <i style={{ width: `${Math.min(100, (d.today.marketingSent / (d.today.dailyCap * connectedNumbers(d))) * 100)}%`, background: 'var(--brand)' }} />
                </div>
              </div>
              <b>{formatNumber(d.today.marketingSent)}</b>
            </div>
            <div className="dash-list-row">
              <div>
                New leads shared out
                <span>auto-assign between callers</span>
              </div>
              <Link to="/account" className={`badge ${d.setup.autoAssign ? 'green' : ''}`}>
                {d.setup.autoAssign ? '✓ On' : 'Off'}
              </Link>
            </div>
            <div className="dash-list-row">
              <div>
                Call app
                <span>
                  {d.setup.callApp.connected} of {plural(d.setup.callApp.callers, 'caller')} connected
                </span>
              </div>
              <span className={`badge ${missingApp > 0 ? 'amber' : 'green'}`}>{missingApp > 0 ? `! ${missingApp} missing` : '✓ All set'}</span>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}

/** Connected WhatsApp numbers (each has its own daily limit). */
function connectedNumbers(d: DashboardData): number {
  return Math.max(1, d.setup.sessions.filter(s => s.status === 'ready').length);
}
