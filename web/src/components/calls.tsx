import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { CallApp, CallDirection, LeadCalls, TeamMember } from '../api';
import { Card } from './ui';
import { IconDownload } from './icons';
import { formatCallLength, formatTime, relativeTime } from '../format';
import { memberName } from '../team';

export const DIRECTION_LABEL: Record<CallDirection, string> = {
  outgoing: 'Called',
  incoming: 'They called',
  missed: 'Missed call',
  rejected: 'Declined',
};

/** On a lead's row: the last call and its length, or a warning that the remark has no call behind it. */
export function LeadCallCell({ calls, byId }: { calls: LeadCalls | undefined; byId?: Map<number, TeamMember> }) {
  if (!calls) return <span className="muted">—</span>;
  const last = calls.last;
  const who = last && byId ? byId.get(last.userId) : undefined;
  return (
    <div className="call-cell">
      {last ? (
        <>
          <span className={`call-last ${last.duration > 0 ? 'answered' : 'unanswered'}`} title={new Date(last.at).toLocaleString()}>
            📞 {DIRECTION_LABEL[last.direction]} {relativeDay(last.at)} <span className="nowrap">{formatTime(last.at)}</span>
            {' · '}
            <span className="nowrap">{last.duration > 0 ? formatCallLength(last.duration) : 'not answered'}</span>
          </span>
          <span className="small muted">
            {calls.calls} call{calls.calls === 1 ? '' : 's'}
            {calls.talkSeconds > 0 ? `, ${formatCallLength(calls.talkSeconds)} in all` : ''}
            {who ? ` · ${memberName(who)}` : ''}
          </span>
        </>
      ) : (
        <span className="muted small">No calls yet</span>
      )}
      {calls.remarkWithoutCall && (
        <span className="call-warning" title="A remark was written but no call to this number was recorded before it">
          ⚠️ No call before this remark
        </span>
      )}
    </div>
  );
}

function relativeDay(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'today';
  if (date.toDateString() === yesterday.toDateString()) return 'yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "Seen 5 min ago", or a warning when a phone has gone quiet (it sends every 15 minutes). */
export function PhoneSeen({ at }: { at: string | null }) {
  if (!at) return <span className="small muted">Not sent yet</span>;
  const quiet = Date.now() - new Date(at).getTime() > 60 * 60_000;
  return <span className={`small ${quiet ? 'error-text' : 'secondary'}`}>{quiet ? `⚠️ Last sent ${relativeTime(at)}` : `Sent ${relativeTime(at)}`}</span>;
}

/** Download link, a QR code to scan with the phone, and the steps to set it up. */
export function GetTheApp({ app }: { app: CallApp }) {
  const [qr, setQr] = useState<string | null>(null);
  const url = app.url ? new URL(app.url, window.location.origin).toString() : null;
  useEffect(() => {
    if (!url) return;
    let live = true;
    void QRCode.toDataURL(url, { margin: 1, width: 180, errorCorrectionLevel: 'M' }).then(data => live && setQr(data));
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <Card title="Get the WA Reach Calls app" subtitle={`For Android phones · version ${app.version}`}>
      {url ? (
        <div className="row wrap" style={{ gap: 20, alignItems: 'flex-start' }}>
          {qr && <img src={qr} alt="QR code to download WA Reach Calls" width={180} height={180} className="app-qr" />}
          <div className="stack tight" style={{ flex: '1 1 260px' }}>
            <ol className="setup-steps">
              <li>On the company phone, scan this code with the camera, or open the link below.</li>
              <li>Download the file and open it. If Android asks, allow installing apps from your browser.</li>
              <li>Open WA Reach Calls and sign in with that person's WA Reach email and password.</li>
              <li>
                Allow <strong>call history</strong>, and <strong>music and audio</strong> for recordings. Tap Allow next to "Runs in the background" too.
              </li>
            </ol>
            <div>
              <a className="btn" href={url} download>
                <IconDownload size={16} /> Download WA Reach Calls
              </a>
            </div>
            <p className="hint" style={{ margin: 0 }}>
              Only calls with your leads are kept; every other call on the phone is ignored. Recordings come from the phone's own dialer, so turn on call recording in
              the Phone app's settings if the phone has it. iPhones can't share their call history, so this works on Android only.
            </p>
          </div>
        </div>
      ) : (
        <p className="muted">The app file isn't on this server yet. Update WA Reach (bash deploy/update.sh) and reload this page.</p>
      )}
    </Card>
  );
}
