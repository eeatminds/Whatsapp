import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  del,
  patch,
  put,
  useApi,
  errorMessage,
  type CallApp,
  type CallDevice,
  type CallRecord,
  type CallsReport,
  type Paged,
  type Settings,
  type TeamMember,
} from '../api';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader, Pagination, Segmented, useConfirm, useToast } from '../components/ui';
import { DIRECTION_LABEL, GetTheApp, PhoneStatus, phoneProblems } from '../components/calls';
import { formatCallLength, formatDateTime, formatPhone, relativeTime } from '../format';
import { memberLabel, memberName, useTeam } from '../team';
import { useSession } from '../session';

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
  if (call.recording === 'deleted') return <span className="small muted">Deleted after {keepDays ?? 30} days</span>;
  return <span className="small muted">{call.answered ? 'No recording' : '—'}</span>;
}

/** The first line of a crash report, short enough for a phone's row. */
function firstLine(message: string): string {
  const line = message.split('\n')[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/**
 * Everyone in the team and their phones. The admin adds people to the call app and removes them;
 * removing someone signs their phones out at once and stops them signing in again.
 */
function CallAppTeam({
  team,
  devices,
  app,
  isAdmin,
  onChanged,
}: {
  team: TeamMember[];
  devices: CallDevice[];
  app: CallApp | undefined;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState<number | null>(null);

  const setAccess = async (m: TeamMember, allowed: boolean) => {
    if (
      !allowed &&
      !(await confirm(
        `Remove ${memberName(m)} from the call app?`,
        "Their phone stops sending calls now, and they can't sign in on the app until you add them back. Calls already recorded stay.",
        {
          confirmLabel: 'Remove',
          danger: true,
        },
      ))
    ) {
      return;
    }
    setBusy(m.id);
    try {
      await patch(`/api/account/users/${m.id}`, { callApp: allowed });
      toast.success(allowed ? `${memberName(m)} can now sign in on the call app` : `${memberName(m)} was removed from the call app`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async (device: CallDevice, m: TeamMember) => {
    if (
      !(await confirm(`Sign out ${device.name}?`, `${memberName(m)}'s calls stop coming in until they sign in on that phone again.`, {
        confirmLabel: 'Sign out',
        danger: true,
      }))
    )
      return;
    try {
      await del(`/api/call-devices/${device.id}`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card
      title="Who uses the call app"
      subtitle={
        isAdmin
          ? 'Add or remove people. Removing someone signs their phone out at once. A phone that stops checking in for a day shows as stopped.'
          : 'Only the admin can add or remove people.'
      }
    >
      <div className="stack">
        {team.map(m => {
          const phones = devices.filter(d => d.userId === m.id);
          return (
            <div key={m.id} className="team-row">
              <div className="stack tight" style={{ flex: '1 1 280px' }}>
                <strong>{memberLabel(m)}</strong>
                {!m.callApp ? (
                  <span className="small muted">Not in the call app</span>
                ) : phones.length === 0 ? (
                  <span className={`small ${m.role === 'caller' ? 'error-text' : 'muted'}`}>
                    {m.role === 'caller' ? '⚠️ ' : ''}No phone connected. Install the app and sign in as {m.email}.
                  </span>
                ) : (
                  phones.map(d => (
                    <div key={d.id} className="stack tight">
                      <span className="small secondary">
                        {d.name}
                        {d.appVersion ? ` · app ${d.appVersion}` : ''}
                        {app && d.appVersion && d.appVersion !== app.version ? ' (update available)' : ''}
                      </span>
                      <PhoneStatus device={d} />
                      {d.recordings === 'denied' && <span className="small muted">Recordings not allowed on this phone</span>}
                      {d.recordings === 'allowed' && d.dialerRecordings === 'none' && (
                        <span className="small warn-text">⚠️ This phone's dialer saved no call recordings in the last week. Turn on automatic call recording in its Phone app.</span>
                      )}
                      {d.recordings === 'allowed' && d.dialerRecordings && d.dialerRecordings !== 'none' && (
                        <span className="small muted">
                          Recordings found in {d.dialerRecordings.folder || 'the phone'} · newest {relativeTime(d.dialerRecordings.at)}
                        </span>
                      )}
                      {d.dialer === 'com.google.android.dialer' && (
                        <span className="small warn-text">
                          ⚠️ This phone uses Google's Phone app, which keeps its call recordings to itself, so they can't be sent. If the phone has its maker's own Phone
                          app, make that the default and turn on automatic call recording in it.
                        </span>
                      )}
                      {d.recordingCheck && (
                        <span className="small muted">
                          Last recording check ({relativeTime(d.recordingCheck.at)}): {d.recordingCheck.text}
                        </span>
                      )}
                      {d.background === 'restricted' && (
                        <span className="small muted">
                          Android may pause the app in the background, so calls can arrive late. In the app, tap Allow next to "Runs in the background".
                        </span>
                      )}
                      {d.problem && (
                        <span className="small muted" title={d.problem.message}>
                          The app closed unexpectedly {relativeTime(d.problem.at)}: {firstLine(d.problem.message)}
                        </span>
                      )}
                      {isAdmin && (
                        <div>
                          <Button size="sm" variant="ghost" onClick={() => void signOut(d, m)}>
                            Sign out this phone
                          </Button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
              {isAdmin &&
                m.role !== 'owner' &&
                (m.callApp ? (
                  <Button size="sm" variant="ghost" loading={busy === m.id} onClick={() => void setAccess(m, false)}>
                    Remove from call app
                  </Button>
                ) : (
                  <Button size="sm" loading={busy === m.id} onClick={() => void setAccess(m, true)}>
                    Add to call app
                  </Button>
                ))}
            </div>
          );
        })}
      </div>
      {dialog}
    </Card>
  );
}

export function CallsPage() {
  const { me } = useSession();
  const isAdmin = me.user?.role === 'owner' || me.user?.role === 'platform_admin';
  const { team, byId, reload: reloadTeam } = useTeam();
  const toast = useToast();
  const [period, setPeriod] = useState<Period>('7');
  const [person, setPerson] = useState('');
  const [page, setPage] = useState(1);
  const range = useMemo(() => rangeOf(period), [period]);

  const {
    data: report,
    error: reportError,
    reload: reloadReport,
  } = useApi<CallsReport>(`/api/calls/report?${query(range)}`, {
    poll: 60_000,
  });
  const { data: app } = useApi<CallApp>('/api/call-app');
  const { data: list, error: listError } = useApi<Paged<CallRecord>>(`/api/calls?${query({ ...range, userId: person || undefined, page, pageSize: 25 })}`, {
    poll: 60_000,
  });
  const { data: settings, setData: setSettings } = useApi<Settings>('/api/settings');
  const [keepDays, setKeepDays] = useState<string | null>(null);

  if (!report) return reportError ? <ErrorNote error={reportError} /> : <Loading />;
  const name = (userId: number) => (byId.get(userId) ? memberName(byId.get(userId)!) : 'Someone no longer in the team');
  const phonesOf = (userId: number) => report.devices.filter(d => d.userId === userId);
  // Everyone with a phone or calls in the period, busiest first.
  const people = [
    ...report.people,
    ...[...new Set(report.devices.map(d => d.userId))]
      .filter(id => !report.people.some(p => p.userId === id))
      .map(userId => ({
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

  const problems = phoneProblems(team, report.devices);
  const teamCard = (
    <CallAppTeam
      team={team}
      devices={report.devices}
      app={app}
      isAdmin={isAdmin}
      onChanged={() => {
        void reloadTeam();
        void reloadReport();
      }}
    />
  );

  return (
    <div className="page">
      <PageHeader title="Calls" description="Calls your team makes to leads from their phones: when, how long, and the recording when the phone makes one." />

      {problems.length > 0 && (
        <div className="callout warn" role="status">
          <div>
            <strong>Check these phones</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {problems.map(p => (
                <li key={p.key}>{p.text}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {!report.tracking ? (
        <>
          <Card>
            <Empty title="No phones connected yet">
              Install WA Reach Calls on each caller's Android phone and sign in with their WA Reach login. Their calls to leads then show here and next to each
              lead, and remarks written without a call are flagged.
            </Empty>
          </Card>
          {teamCard}
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
                                  <PhoneStatus device={d} short />
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
                              <Badge tone={call.answered ? 'green' : call.direction === 'missed' ? 'amber' : undefined}>
                                {DIRECTION_LABEL[call.direction]}
                              </Badge>
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

          {teamCard}

          <Card title="Recordings" subtitle="Kept on your server, out of the daily backups, then deleted. Call times and lengths stay.">
            {settings ? (
              <form
                className="row wrap"
                style={{ gap: 8, alignItems: 'flex-end' }}
                onSubmit={async e => {
                  e.preventDefault();
                  try {
                    setSettings(
                      await put<Settings>('/api/settings', {
                        callRecordingDays: Number(keepDays ?? settings.callRecordingDays),
                      }),
                    );
                    setKeepDays(null);
                    toast.success('Saved');
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <Field label="Delete recordings after (days)" hint="7 to 30 days. Tell customers calls may be recorded, and say so in your privacy policy.">
                  <input
                    className="input"
                    type="number"
                    min={7}
                    max={30}
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

          {app && <GetTheApp app={app} />}
        </>
      )}
    </div>
  );
}
