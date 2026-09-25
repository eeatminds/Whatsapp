import { useEffect, useState } from 'react';
import { post, put, useApi, errorMessage, type Settings, type SystemInfo } from '../api';
import { Badge, Button, Callout, Card, ErrorNote, Field, Loading, NumberInput, PageHeader, Toggle, useToast } from '../components/ui';
import { SessionSelect } from '../components/pickers';
import { useSession } from '../session';
import { suggestedTimeZones, timeZoneOptions } from '../timezones';

export function SettingsPage() {
  const { data, error, loading } = useApi<Settings>('/api/settings');
  const system = useApi<SystemInfo>('/api/system');
  const [form, setForm] = useState<Settings | null>(null);
  const [optOut, setOptOut] = useState('');
  const [optIn, setOptIn] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sync, setSync] = useState<Array<{ name: string; result: string }> | null>(null);
  const toast = useToast();
  const { me } = useSession();
  // Sending limits are part of the plan; only the platform admin (e.g. viewing this business) can change them.
  const canEditLimits = me.user?.role === 'platform_admin';
  const provider = me.brand.supportContact ? `Contact ${me.brand.supportContact} to raise them.` : 'Contact your provider to raise them.';

  useEffect(() => {
    if (data) {
      setForm(data);
      setOptOut(data.compliance.optOutKeywords.join(', '));
      setOptIn(data.compliance.optInKeywords.join(', '));
    }
  }, [data]);

  if ((loading && !data) || !form) return <Loading />;

  const save = async () => {
    setBusy('save');
    setSaveError(null);
    try {
      const split = (s: string) => s.split(',').map(k => k.trim()).filter(Boolean);
      const saved = await put<Settings>('/api/settings', { ...form, compliance: { ...form.compliance, optOutKeywords: split(optOut), optInKeywords: split(optIn) } });
      setForm(saved);
      toast.success('Settings saved');
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const sys = system.data;
  return (
    <div className="page">
      <PageHeader
        title="Settings"
        description="Business details, sending limits and compliance."
        actions={
          <Button variant="primary" loading={busy === 'save'} onClick={save}>
            Save settings
          </Button>
        }
      />
      <ErrorNote error={error ?? saveError} />

      <Card title="Business">
        <div className="grid cols-2">
          <Field label="Business name" hint="Available in messages as {{business_name}}.">
            <input className="input" value={form.businessName} onChange={e => setForm({ ...form, businessName: e.target.value })} />
          </Field>
          <Field label="Default WhatsApp number" hint="Used when a campaign, sequence or reply doesn't pick one.">
            <SessionSelect value={form.defaultSessionId} onChange={defaultSessionId => setForm({ ...form, defaultSessionId })} />
          </Field>
          <Field label="Time zone" hint="Quiet hours, daily limits and charts use this. Offsets are for today; daylight saving is handled automatically.">
            <select className="select" value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })}>
              <optgroup label="Suggested">
                {suggestedTimeZones(form.timezone).map(tz => (
                  <option key={`s-${tz.id}`} value={tz.id}>
                    {tz.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="All time zones">
                {timeZoneOptions().map(tz => (
                  <option key={tz.id} value={tz.id}>
                    {tz.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label="Default country" hint="Two-letter code for numbers entered without a country code, e.g. IN, AE, GB.">
            <input className="input" maxLength={2} value={form.defaultCountry} onChange={e => setForm({ ...form, defaultCountry: e.target.value.toUpperCase() })} />
          </Field>
        </div>
      </Card>

      <Card
        title="Sending limits"
        subtitle={
          canEditLimits
            ? 'Set by you as the platform admin. The business sees these but cannot change them.'
            : `These limits are part of your plan and protect your numbers from being restricted. ${provider}`
        }
      >
        <div className="grid cols-3">
          <Field label="Max marketing messages per day, per number" hint="Replies and confirmations don't count.">
            <NumberInput disabled={!canEditLimits} value={form.sending.dailyCapPerSession} min={1} max={100000} onChange={v => setForm({ ...form, sending: { ...form.sending, dailyCapPerSession: v } })} />
          </Field>
          <Field label="Max messages per minute, per number">
            <NumberInput disabled={!canEditLimits} value={form.sending.sessionMaxPerMinute} min={1} max={60} onChange={v => setForm({ ...form, sending: { ...form.sending, sessionMaxPerMinute: v } })} />
          </Field>
          <Field label="Default campaign pace (per minute)" hint={canEditLimits ? undefined : 'You can choose a slower pace on each campaign.'}>
            <NumberInput disabled={!canEditLimits} value={form.sending.defaultPerMinute} min={1} max={60} onChange={v => setForm({ ...form, sending: { ...form.sending, defaultPerMinute: v } })} />
          </Field>
          <Field label="Frequency cap (hours)" hint="Skip anyone who got a marketing message this recently. 0 = off.">
            <NumberInput disabled={!canEditLimits} value={form.sending.frequencyCapHours} min={0} max={720} onChange={v => setForm({ ...form, sending: { ...form.sending, frequencyCapHours: v } })} />
          </Field>
          <Field label="Pause a campaign after this many failures in a row">
            <NumberInput disabled={!canEditLimits} value={form.sending.breakerThreshold} min={1} max={100} onChange={v => setForm({ ...form, sending: { ...form.sending, breakerThreshold: v } })} />
          </Field>
        </div>
      </Card>

      <Card title="Reporting">
        <div className="grid cols-3">
          <Field label="Reply attribution window (hours)" hint="A reply within this time counts toward the campaign.">
            <NumberInput value={form.attributionWindowHours} min={1} max={720} onChange={v => setForm({ ...form, attributionWindowHours: v })} />
          </Field>
        </div>
      </Card>

      <Card title="Quiet hours" subtitle="Campaigns and drip messages wait during these hours. Replies to people who message you still go out.">
        <div className="row wrap" style={{ gap: 16 }}>
          <Toggle checked={form.quietHours.enabled} onChange={enabled => setForm({ ...form, quietHours: { ...form.quietHours, enabled } })} label="Enabled" />
          <Field label="From">
            <input className="input" type="time" value={form.quietHours.start} onChange={e => setForm({ ...form, quietHours: { ...form.quietHours, start: e.target.value } })} />
          </Field>
          <Field label="Until">
            <input className="input" type="time" value={form.quietHours.end} onChange={e => setForm({ ...form, quietHours: { ...form.quietHours, end: e.target.value } })} />
          </Field>
        </div>
      </Card>

      <Card title="Consent and unsubscribes" subtitle="Keywords are matched on the whole message, ignoring case and punctuation.">
        <div className="grid cols-2">
          <Field label="Unsubscribe keywords">
            <input className="input" value={optOut} onChange={e => setOptOut(e.target.value)} />
          </Field>
          <Field label="Subscribe keywords">
            <input className="input" value={optIn} onChange={e => setOptIn(e.target.value)} />
          </Field>
          <Field label="Reply after unsubscribing">
            <textarea className="textarea" rows={3} value={form.compliance.optOutReply} onChange={e => setForm({ ...form, compliance: { ...form.compliance, optOutReply: e.target.value } })} />
          </Field>
          <Field label="Reply after subscribing">
            <textarea className="textarea" rows={3} value={form.compliance.optInReply} onChange={e => setForm({ ...form, compliance: { ...form.compliance, optInReply: e.target.value } })} />
          </Field>
          <Field label="Unsubscribe line added to marketing messages">
            <input className="input" value={form.compliance.optOutFooter} onChange={e => setForm({ ...form, compliance: { ...form.compliance, optOutFooter: e.target.value } })} />
          </Field>
        </div>
      </Card>

      <Card title="Connection" subtitle={canEditLimits ? 'Configured with environment variables on the server.' : 'Managed by your provider.'}>
        {!sys ? (
          <Loading />
        ) : (
          <div className="stack">
            <dl className="kv">
              <dt>WhatsApp gateway</dt>
              <dd>
                {sys.openwaUrl && <span className="mono">{sys.openwaUrl} </span>}
                {sys.gateway.reachable ? <Badge tone="green">Reachable</Badge> : <Badge tone="red">Unreachable</Badge>}
                {sys.gateway.lastError && <div className="small error-text">{sys.gateway.lastError}</div>}
              </dd>
              {sys.webhookUrl && (
                <>
                  <dt>Webhook URL</dt>
                  <dd className="mono">{sys.webhookUrl}</dd>
                </>
              )}
              <dt>Click tracking</dt>
              <dd>{sys.trackingEnabled ? <span className="mono">{sys.publicUrl}/r/…</span> : canEditLimits ? 'Off (set PUBLIC_URL)' : 'Off'}</dd>
              <dt>REST API</dt>
              <dd>
                Create an API key under <a href="/account">Account & billing</a> to add contacts from forms, CRMs or n8n.
              </dd>
              <dt>Pending replies</dt>
              <dd>{sys.pendingReplies}</dd>
            </dl>
            <div>
              <Button
                loading={busy === 'sync'}
                onClick={async () => {
                  setBusy('sync');
                  try {
                    const r = await post<{ results: Array<{ name: string; result: string }> }>('/api/system/sync-webhooks');
                    setSync(r.results);
                    void system.reload();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Re-register webhooks
              </Button>
            </div>
            {sync && (
              <Callout tone={sync.some(r => r.result.startsWith('error')) ? 'warn' : 'success'}>
                {sync.length === 0 ? 'No numbers yet.' : sync.map(r => `${r.name}: ${r.result}`).join(' · ')}
              </Callout>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
