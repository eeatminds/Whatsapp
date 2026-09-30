import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { put, useApi, errorMessage, LEAD_STAGES, type Contact, type ContactFilter, type LeadReport, type LeadStage, type Paged } from '../api';
import { Button, Card, Empty, ErrorNote, Loading, PageHeader, Pagination, Segmented, TagChip, useToast } from '../components/ui';
import { Funnel } from '../components/charts';
import { IconDownload, IconSearch } from '../components/icons';
import { displayName, formatDateTime, formatNumber, formatPhone, percent, relativeTime } from '../format';

type Preset = '7' | '30' | '90' | 'month' | 'all' | 'custom';

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function rangeFor(preset: Preset, custom: { from: string; to: string }): { from?: string; to?: string } {
  const today = new Date();
  if (preset === 'all') return {};
  if (preset === 'custom') return { from: custom.from || undefined, to: custom.to || undefined };
  if (preset === 'month') return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymd(today) };
  const start = new Date(today);
  start.setDate(start.getDate() - (Number(preset) - 1));
  return { from: ymd(start), to: ymd(today) };
}

function rangeLabel(range: { from?: string; to?: string }): string {
  const fmt = (v: string) => new Date(`${v}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (!range.from && !range.to) return 'All time';
  if (range.from && range.to) return `${fmt(range.from)} to ${fmt(range.to)}`;
  return range.from ? `From ${fmt(range.from)}` : `Until ${fmt(range.to!)}`;
}

function query(params: { [key: string]: string | number | undefined | unknown[] }): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && !Array.isArray(v)) out.set(k, String(v));
  return out.toString();
}

const STAGE_LABEL = Object.fromEntries(LEAD_STAGES.map(s => [s.value, s.label])) as Record<LeadStage, string>;

export function StagePill({ stage }: { stage: LeadStage }) {
  return (
    <span className={`stage-pill stage-${stage}`}>
      <span className="dot" />
      {STAGE_LABEL[stage]}
    </span>
  );
}

function StageSelect({ contact, onSaved }: { contact: Contact; onSaved: (c: Contact) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <select
      className={`stage-select stage-${contact.leadStage}`}
      value={contact.leadStage}
      disabled={busy}
      aria-label={`Lead stage for ${displayName(contact)}`}
      onChange={async e => {
        setBusy(true);
        try {
          onSaved(await put<Contact>(`/api/contacts/${contact.id}/lead`, { stage: e.target.value }));
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {LEAD_STAGES.map(s => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

function RemarkCell({ contact, onSaved }: { contact: Contact; onSaved: (c: Contact) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(contact.leadRemark ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(contact.leadRemark ?? ''), [contact.leadRemark]);

  const save = async () => {
    setBusy(true);
    try {
      onSaved(await put<Contact>(`/api/contacts/${contact.id}/lead`, { remark: text.trim() }));
      setEditing(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="stack tight remark-edit">
        <textarea
          className="textarea"
          rows={3}
          autoFocus
          maxLength={2000}
          value={text}
          placeholder="What was discussed on the call, next step…"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <div className="row">
          <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="remark-view" onClick={() => setEditing(true)} title="Click to edit the remark">
      {contact.leadRemark ? (
        <>
          <span className="remark-text">{contact.leadRemark}</span>
          <span className="small muted">
            {contact.leadRemarkBy}
            {contact.leadRemarkAt ? ` · ${relativeTime(contact.leadRemarkAt)}` : ''}
          </span>
        </>
      ) : (
        <span className="small muted">+ Add remark</span>
      )}
    </button>
  );
}

function ScoreBoard({ report, onStage, active }: { report: LeadReport; onStage: (s: LeadStage | undefined) => void; active?: LeadStage }) {
  const total = report.total;
  return (
    <Card title="Score board" subtitle="Leads added in this period, by where they are now.">
      <div className="scoreboard">
        <div>
          <div className="stat-label">Total leads</div>
          <div className="hero-number">{formatNumber(total)}</div>
        </div>
        <div className="stack" style={{ gap: 10, flex: 1, minWidth: 0 }}>
          <div className="stage-bar" role="img" aria-label={LEAD_STAGES.map(s => `${s.label} ${report.byStage[s.value]}`).join(', ')}>
            {total > 0 &&
              LEAD_STAGES.filter(s => report.byStage[s.value] > 0).map(s => (
                <span
                  key={s.value}
                  className={`stage-seg stage-${s.value}`}
                  style={{ flexGrow: report.byStage[s.value] }}
                  title={`${s.label}: ${formatNumber(report.byStage[s.value])} (${percent(report.byStage[s.value], total)})`}
                />
              ))}
          </div>
          <div className="stage-legend">
            {LEAD_STAGES.map(s => (
              <button
                key={s.value}
                type="button"
                className={`stage-legend-item ${active === s.value ? 'active' : ''}`}
                onClick={() => onStage(active === s.value ? undefined : s.value)}
                title={`Show ${s.label.toLowerCase()} leads below`}
              >
                <span className={`swatch stage-${s.value}`} />
                <span className="secondary">{s.label}</span>
                <strong>{formatNumber(report.byStage[s.value])}</strong>
                <span className="small muted">{percent(report.byStage[s.value], total)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

function downloadChannels(report: LeadReport) {
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [
    ['Channel', 'Leads', 'Untouched', 'Warm', 'Cold', 'Closed'],
    ...report.channels.map(c => [c.name, c.leads, c.untouched, c.warm, c.cold, c.closed]),
  ];
  const blob = new Blob(['﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lead-channels.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Channels({ report, onChannel, active }: { report: LeadReport; onChannel: (key: string | undefined) => void; active?: string }) {
  return (
    <Card
      title="Top performing channels"
      subtitle="Where leads came from. Click a row to see its leads."
      bodyClass=""
      actions={
        report.channels.length > 0 && (
          <Button size="sm" variant="ghost" icon={<IconDownload size={15} />} onClick={() => downloadChannels(report)}>
            CSV
          </Button>
        )
      }
    >
      {report.channels.length === 0 ? (
        <p className="muted" style={{ padding: '16px 20px' }}>
          No leads in this period.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="num">Leads</th>
                <th className="num">Warm</th>
                <th className="num">Closed</th>
                <th className="num">Closed rate</th>
              </tr>
            </thead>
            <tbody>
              {report.channels.map(c => (
                <tr key={c.key} className={`clickable ${active === c.key ? 'selected' : ''}`} onClick={() => onChannel(active === c.key ? undefined : c.key)}>
                  <td>{c.name}</td>
                  <td className="num nowrap">
                    {formatNumber(c.leads)} <span className="small muted">({percent(c.leads, report.total, 1)})</span>
                  </td>
                  <td className="num">{formatNumber(c.warm)}</td>
                  <td className="num">{formatNumber(c.closed)}</td>
                  <td className="num">{percent(c.closed, c.leads, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function LeadsPage() {
  const [params, setParams] = useSearchParams();
  const [preset, setPreset] = useState<Preset>((params.get('range') as Preset) || '30');
  const [custom, setCustom] = useState({ from: params.get('from') ?? '', to: params.get('to') ?? '' });
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const stage = (params.get('stage') as LeadStage | null) ?? undefined;
  const channel = params.get('channel') ?? undefined;
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const setFilter = (next: { stage?: LeadStage; channel?: string }) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
    setPage(1);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const reportPath = `/api/leads/report?${query(range)}`;
  const { data: report, error: reportError, loading: reportLoading, reload: reloadReport } = useApi<LeadReport>(reportPath);
  const filter = { ...range, stage, channel, q: q || undefined } satisfies ContactFilter;
  const listPath = `/api/contacts?${query({ ...filter, page, pageSize: 25 })}`;
  const { data: list, error: listError, setData } = useApi<Paged<Contact>>(listPath);

  // Update the row in place (it stays visible even if it no longer matches the stage filter
  // until the next reload), and refresh the numbers above.
  const onSaved = (c: Contact) => {
    setData(prev => prev && { ...prev, items: prev.items.map(i => (i.id === c.id ? c : i)) });
    void reloadReport();
  };

  if (reportLoading && !report) return <Loading />;
  const channelName = channel ? (report?.channels.find(c => c.key === channel)?.name ?? 'this channel') : null;

  return (
    <div className="page">
      <PageHeader
        title="Leads"
        description="Every lead in one place: where it came from, its stage, and what was said on the call."
        actions={
          <a className="btn" href={`/api/contacts/export.csv?${query(filter)}`}>
            <IconDownload size={16} /> Export
          </a>
        }
      />
      <div className="row wrap lead-range">
        <Segmented value={preset} onChange={setPreset} options={PRESETS} />
        {preset === 'custom' && (
          <div className="row">
            <input className="input sm" type="date" value={custom.from} max={custom.to || undefined} onChange={e => setCustom({ ...custom, from: e.target.value })} aria-label="From" />
            <span className="muted">to</span>
            <input className="input sm" type="date" value={custom.to} min={custom.from || undefined} onChange={e => setCustom({ ...custom, to: e.target.value })} aria-label="To" />
          </div>
        )}
        <span className="small muted">Date range: {rangeLabel(range)}</span>
      </div>
      <ErrorNote error={reportError} />
      {report && (
        <>
          <ScoreBoard report={report} active={stage} onStage={s => setFilter({ stage: s })} />
          <div className="grid cols-2">
            <Channels report={report} active={channel} onChannel={key => setFilter({ channel: key })} />
            <Card title="Lead funnel" subtitle="How far leads from this period have got.">
              <Funnel stages={report.funnel.map(f => ({ label: f.label, value: f.count }))} caption="Share of all leads" baseLabel="Of total" />
            </Card>
          </div>
        </>
      )}

      <Card bodyClass="">
        <div className="card-header leads-filters">
          <div className="row wrap" style={{ gap: 10, flex: 1 }}>
            <div className="row" style={{ position: 'relative', minWidth: 200, flex: '1 1 200px', maxWidth: 300 }}>
              <IconSearch size={16} style={{ position: 'absolute', left: 10, color: 'var(--text-muted)' }} />
              <input className="input sm" style={{ paddingLeft: 32 }} value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, phone or email" aria-label="Search leads" />
            </div>
            <Segmented
              value={stage ?? 'all'}
              onChange={v => setFilter({ stage: v === 'all' ? undefined : (v as LeadStage) })}
              options={[{ value: 'all', label: 'All' }, ...LEAD_STAGES.map(s => ({ value: s.value, label: s.label }))]}
            />
            <select className="select sm" style={{ width: 'auto' }} value={channel ?? ''} onChange={e => setFilter({ channel: e.target.value || undefined })} aria-label="Channel">
              <option value="">All channels</option>
              {report?.channels.map(c => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <span className="small muted nowrap">
            {list ? `${formatNumber(list.total)} lead${list.total === 1 ? '' : 's'}` : ''}
            {channelName ? ` from ${channelName}` : ''}
          </span>
        </div>
        <ErrorNote error={listError} />
        {list && list.items.length === 0 ? (
          <Empty title={report?.total ? 'No leads match these filters' : 'No leads yet'}>
            {report?.total ? (
              'Try another stage, channel or date range.'
            ) : (
              <>
                Leads appear here as they come in. <Link to="/automations?tab=leads">Connect a Google Sheet or website form</Link>, or{' '}
                <Link to="/contacts">import a list</Link>.
              </>
            )}
          </Empty>
        ) : (
          list && (
            <>
              <div className="table-wrap">
                <table className="table leads-table">
                  <thead>
                    <tr>
                      <th>Lead</th>
                      <th>Channel</th>
                      <th>Lead stage</th>
                      <th>Lead remark</th>
                      <th>Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map(c => (
                      <tr key={c.id}>
                        <td>
                          <Link to={`/inbox/${c.id}`} className="strong">
                            {displayName(c)}
                          </Link>
                          <div className="small muted mono">{formatPhone(c.phone)}</div>
                          {c.tags.length > 0 && (
                            <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                              {c.tags.slice(0, 3).map(t => (
                                <TagChip key={t.id} tag={t} />
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="secondary small">{c.channel}</td>
                        <td>
                          <StageSelect contact={c} onSaved={onSaved} />
                        </td>
                        <td className="remark-col">
                          <RemarkCell contact={c} onSaved={onSaved} />
                        </td>
                        <td className="secondary small nowrap" title={formatDateTime(c.createdAt)}>
                          {relativeTime(c.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={list.page} pageSize={list.pageSize} total={list.total} onPage={setPage} />
            </>
          )
        )}
      </Card>
    </div>
  );
}
