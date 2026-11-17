import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, put, useApi, errorMessage, type CallApp, type CallDevice, type CallRecord, type CallsReport, type Paged, type Settings } from '../api';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader, Pagination, Segmented, useConfirm, useToast } from '../components/ui';
import { DIRECTION_LABEL, GetTheApp, PhoneSeen } from '../components/calls';
import { formatCallLength, formatDateTime, formatPhone } from '../format';
import { memberName, useTeam } from '../team';

type Period = 'today' | '7' | '30' | 'all';

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function rangeOf(period: Period): { from?: string; to?: string } {
  if (period === 'all') return {};
  const today = new Date();
  const start = new Date(today);
  if (period !== 'today') start.setDate(start.getDate() - (Number(period) - 1));
  return { from: ymd(start), to: ymd(today) };
}

function query(params: Record<string, string | number | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') out.set(k, String(v));
  return out.toString();
}

/** Browsers can't play AMR or 3GP recordings: those are offered as a download. */
const PLAYABLE = /^audio\/(mpeg|mp4|aac|ogg|wav|webm|flac)$/;

function Recording({ call, keepDays }: { call: CallRecord; keepDays: number | undefined }) {
  const [open, setOpen] = useState(false);
  const src = `/api/calls/${call.id}/recording`;
  if (call.recording === 'saved') {
    if (!call.recordingMime || !PLAYABLE.test(call.recordingMime)) {
      return (
        <a href={src} download className="small">
          Download recording
        </a>
      );
    }
    return open ? (
      <audio controls autoPlay preload="none" src={src} className="call-audio" />
    ) : (
      <Button size="sm" onClick={() => setOpen(true)}>
        ▶ Listen
      </Button>
    );
  }
  if (call.recording === 'pending') return <span className="small muted">Waiting for the phone</span>;
  if (call.recording === 'deleted') return <span className="small muted">Deleted after {keepDays ?? 90} days</span>;
  return <span className="small muted">{call.answered ? 'No recording' : '—'}</span>;
}

export function CallsPage() {
  const { team, byId } = useTeam();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [period, setPeriod] = useState<Period>('7');
  const [person, setPerson] = useState('');
  const [page, setPage] = useState(1);
  const range = useMemo(() => rangeOf(period), [period]);

  const { data: report, error: reportError, reload: reloadReport } = useApi<CallsReport>(`/api/calls/report?${query(range)}`, { poll: 60_000 });
  const { data: app } = useApi<CallApp>('/api/call-app');
  const { data: list, error: listError } = useApi<Paged<CallRecord>>(`/api/calls?${query({ ...range, userId: person || undefined, page, pageSize: 25 })}`, { poll: 60_000 });
  const { data: settings, setData: setSettings } = useApi<Settings>('/api/settings');
  const [keepDays, setKeepDays] = useState<string | null>(null);

  if (!report) return reportError ? <ErrorNote error={reportError} /> : <Loading />;
  const name = (userId: number) => (byId.get(userId) ? memberName(byId.get(userId)!) : 'Someone no longer in the team');
  const phonesOf = (userId: number) => report.devices.filter(d => d.userId === userId);
  // Everyone with a phone or calls in the period, busiest first.
  const people = [
    ...report.people,
    ...[...new Set(report.devices.map(d => d.userId))].filter(id => !report.people.some(p => p.userId === id)).map(userId => ({
      userId,
      calls: 0,
      outgoing: 0,
      answered: 0,
      talkSeconds: 0,
      leadsCalled: 0,
      recorded: 0,
      remarksWithoutCall: 0,
    })),
  ];

  const signOut = async (device: CallDevice) => {
    if (!(await confirm(`Sign out ${device.name}?`, `${name(device.userId)}'s calls stop coming in until someone signs in on that phone again.`, { confirmLabel: 'Sign out', danger: true }))) return;
    try {
      await del(`/api/call-devices/${device.id}`);
      void reloadReport();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="page">
      <PageHeader title="Calls" description="Calls your team makes to leads from their phones: when, how long, and the recording when the phone makes one." />

      {!report.tracking ? (
        <>
          <Card>
            <Empty title="No phones connected yet">
              Install WA Reach Calls on each caller's Android phone and sign in with their WA Reach login. Their calls to leads then show here and next to each lead, and
              remarks written without a call are flagged.
            </Empty>
          </Card>
          {app && <GetTheApp app={app} />}
        </>
      ) : (
        <>
          <Segmented
            value={period}
            onChange={v => {
              setPeriod(v);
              setPage(1);
            }}
            options={[
              { value: 'today', label: 'Today' },
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: 'all', label: 'All time' },
            ]}
          />

          <Card title="By person" subtitle="Remarks without a call: leads given to them with a remark but no call to that number before it." bodyClass="">
            {people.length === 0 ? (
              <p className="muted" style={{ padding: '16px 20px' }}>
                No calls with leads in this period.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Phone</th>
                      <th className="num">Calls</th>
                      <th className="num">Answered</th>
                      <th className="num">Talk time</th>
                      <th className="num">Average call</th>
                      <th className="num">Leads called</th>
                      <th className="num">Remarks without a call</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map(p => {
                      const phones = phonesOf(p.userId);
                      return (
                        <tr key={p.userId}>
                          <td>
                            <button type="button" className="link-button strong" onClick={() => setPerson(String(p.userId))}>
                              {name(p.userId)}
                            </button>
                          </td>
                          <td>
                            {phones.length ? (
                              phones.map(d => (
                                <div key={d.id}>
                                  <PhoneSeen at={d.lastSeenAt} />
                                </div>
                              ))
                            ) : (
                              <span className="small error-text">⚠️ No phone connected</span>
                            )}
                          </td>
                          <td className="num">{p.calls}</td>
                          <td className="num">{p.answered}</td>
                          <td className="num">{formatCallLength(p.talkSeconds)}</td>
                          <td className="num">{p.answered ? formatCallLength(p.talkSeconds / p.answered) : '—'}</td>
                          <td className="num">{p.leadsCalled}</td>
                          <td className="num">
                            {p.remarksWithoutCall ? (
                              <Link to={`/leads?assignee=${p.userId}`} className="error-text strong">
                                ⚠️ {p.remarksWithoutCall}
                              </Link>
                            ) : (
                              0
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Calls"
            subtitle="Only calls with your leads; every other call on the phones is ignored."
            bodyClass=""
            actions={
              <select
                className="select sm"
                style={{ width: 'auto' }}
                value={person}
                onChange={e => {
                  setPerson(e.target.value);
                  setPage(1);
                }}
                aria-label="Person"
              >
                <option value="">Everyone</option>
                {team.map(m => (
                  <option key={m.id} value={m.id}>
                    {memberName(m)}
                  </option>
                ))}
              </select>
            }
          >
            <ErrorNote error={listError} />
            {list && list.items.length === 0 ? (
              <p className="muted" style={{ padding: '16px 20px' }}>
                No calls in this period.
              </p>
            ) : (
              list && (
                <>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Person</th>
                          <th>Lead</th>
                          <th>Call</th>
                          <th className="num">Length</th>
                          <th>Recording</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.items.map(call => (
                          <tr key={call.id}>
                            <td className="small nowrap">{formatDateTime(call.startedAt)}</td>
                            <td className="small">{name(call.userId)}</td>
                            <td>
                              {call.contactId ? (
                                <Link to={`/inbox/${call.contactId}`} className="strong">
                                  {call.contactName || formatPhone(call.phone)}
                                </Link>
                              ) : (
                                <span>{formatPhone(call.phone)}</span>
                              )}
                              {call.contactName && <div className="small muted mono">{formatPhone(call.phone)}</div>}
                            </td>
                            <td className="small">
                              <Badge tone={call.answered ? 'green' : call.direction === 'missed' ? 'amber' : undefined}>{DIRECTION_LABEL[call.direction]}</Badge>
                            </td>
                            <td className="num">{call.answered ? formatCallLength(call.duration) : 'Not answered'}</td>
                            <td>
                              <Recording call={call} keepDays={settings?.callRecordingDays} />
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

          <div className="grid cols-2">
            <Card title="Connected phones" subtitle="Each phone sends its calls every 15 minutes and right after each call.">
              {report.devices.length === 0 ? (
                <p className="muted">No phones connected.</p>
              ) : (
                <div className="stack">
                  {report.devices.map(d => (
                    <div key={d.id} className="team-row">
                      <div className="stack tight">
                        <strong>{name(d.userId)}</strong>
                        <span className="small secondary">
                          {d.name}
                          {d.appVersion ? ` · app ${d.appVersion}` : ''}
                          {app && d.appVersion && d.appVersion !== app.version ? ' (update available)' : ''}
                        </span>
                        <PhoneSeen at={d.lastSeenAt} />
                        {d.recordings === 'denied' && <span className="small muted">Recordings not allowed on this phone</span>}
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => void signOut(d)}>
                        Sign out
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Recordings" subtitle="Kept on your server, out of the daily backups, then deleted. Call times and lengths stay.">
              {settings ? (
                <form
                  className="row wrap"
                  style={{ gap: 8, alignItems: 'flex-end' }}
                  onSubmit={async e => {
                    e.preventDefault();
                    try {
                      setSettings(await put<Settings>('/api/settings', { callRecordingDays: Number(keepDays ?? settings.callRecordingDays) }));
                      setKeepDays(null);
                      toast.success('Saved');
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  <Field label="Delete recordings after (days)" hint="7 to 730 days. Tell customers calls may be recorded, and say so in your privacy policy.">
                    <input
                      className="input"
                      type="number"
                      min={7}
                      max={730}
                      value={keepDays ?? settings.callRecordingDays}
                      onChange={e => setKeepDays(e.target.value)}
                      style={{ width: 120 }}
                    />
                  </Field>
                  <Button type="submit" disabled={keepDays === null}>
                    Save
                  </Button>
                </form>
              ) : (
                <Loading />
              )}
            </Card>
          </div>

          {app && <GetTheApp app={app} />}
        </>
      )}
      {dialog}
    </div>
  );
}
