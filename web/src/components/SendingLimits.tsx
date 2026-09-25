import { useEffect, useState } from 'react';
import type { Settings } from '../api';
import { Button, Field, NumberInput } from './ui';
import { formatNumber } from '../format';

export type SendingLimits = Settings['sending'];

/** Editable sending limits for one business (platform admin only). */
export function SendingLimitsForm({ value, onSave }: { value: SendingLimits; onSave: (next: SendingLimits) => Promise<void> }) {
  const [form, setForm] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(value), [value]);
  const dirty = JSON.stringify(form) !== JSON.stringify(value);
  const set = (patch: Partial<SendingLimits>) => setForm({ ...form, ...patch });
  return (
    <div className="stack">
      <div className="grid cols-2">
        <Field label="Marketing messages per day, per number" hint="Replies and confirmations don't count.">
          <NumberInput min={1} max={100000} value={form.dailyCapPerSession} onChange={dailyCapPerSession => set({ dailyCapPerSession })} />
        </Field>
        <Field label="Max messages per minute, per number">
          <NumberInput min={1} max={60} value={form.sessionMaxPerMinute} onChange={sessionMaxPerMinute => set({ sessionMaxPerMinute })} />
        </Field>
        <Field label="Default campaign pace (per minute)" hint="Can't be above the per-minute maximum.">
          <NumberInput min={1} max={60} value={form.defaultPerMinute} onChange={defaultPerMinute => set({ defaultPerMinute })} />
        </Field>
        <Field label="Pause a campaign after this many failures in a row">
          <NumberInput min={1} max={100} value={form.breakerThreshold} onChange={breakerThreshold => set({ breakerThreshold })} />
        </Field>
        <Field label="Frequency cap (hours)" hint="Skip anyone who got a marketing message this recently. 0 = off.">
          <NumberInput min={0} max={720} value={form.frequencyCapHours} onChange={frequencyCapHours => set({ frequencyCapHours })} />
        </Field>
      </div>
      <div className="row wrap">
        <span className="small secondary">Raise the daily limit:</span>
        {[50, 100, 250].map(step => (
          <Button key={step} size="sm" onClick={() => set({ dailyCapPerSession: Math.min(100000, form.dailyCapPerSession + step) })}>
            +{step}
          </Button>
        ))}
      </div>
      <p className="hint">
        Raise limits gradually as a number ages and people reply, e.g. +100 a day each month. Now: {formatNumber(form.dailyCapPerSession)} per number per day.
      </p>
      <div>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(form);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save limits
        </Button>
      </div>
    </div>
  );
}
