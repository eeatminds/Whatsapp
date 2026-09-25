import { useState } from 'react';
import { post, useApi, errorMessage, type Condition, type Rules, type Session, type Tag, type Campaign } from '../api';
import { Button, TagChip, useToast } from './ui';
import { IconPlus, IconX } from './icons';

export function useTags() {
  return useApi<Tag[]>('/api/tags');
}

/** Multi-select for tags with inline "create tag". */
export function TagPicker({ value, onChange, allowCreate = true, placeholder = 'Add tag…', suggest = true }: {
  value: number[];
  onChange: (ids: number[]) => void;
  allowCreate?: boolean;
  placeholder?: string;
  /** Show existing tags as one-click chips while nothing is picked. */
  suggest?: boolean;
}) {
  const { data: tags, reload } = useTags();
  const [query, setQuery] = useState('');
  const toast = useToast();
  const selected = (tags ?? []).filter(t => value.includes(t.id));
  const options = (tags ?? []).filter(t => !value.includes(t.id) && t.name.toLowerCase().includes(query.toLowerCase()));
  const exact = (tags ?? []).some(t => t.name.toLowerCase() === query.trim().toLowerCase());

  const create = async () => {
    try {
      const tag = await post<Tag>('/api/tags', { name: query.trim() });
      await reload();
      onChange([...value, tag.id]);
      setQuery('');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="stack tight">
      {selected.length > 0 && (
        <div className="row wrap">
          {selected.map(t => (
            <TagChip key={t.id} tag={t} onRemove={() => onChange(value.filter(id => id !== t.id))} />
          ))}
        </div>
      )}
      <div className="row" style={{ position: 'relative' }}>
        <input
          className="input sm"
          value={query}
          placeholder={placeholder}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (options[0]) {
                onChange([...value, options[0].id]);
                setQuery('');
              } else if (allowCreate && query.trim() && !exact) void create();
            }
          }}
          aria-label={placeholder}
        />
      </div>
      {query && (
        <div className="row wrap">
          {options.slice(0, 12).map(t => (
            <button
              key={t.id}
              type="button"
              className="tag-chip"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                onChange([...value, t.id]);
                setQuery('');
              }}
            >
              <span className="swatch" style={{ background: t.color }} />
              {t.name}
            </button>
          ))}
          {allowCreate && query.trim() && !exact && (
            <Button size="sm" icon={<IconPlus size={14} />} onClick={() => void create()}>
              Create “{query.trim()}”
            </Button>
          )}
        </div>
      )}
      {suggest && !query && (tags ?? []).length > 0 && value.length === 0 && (
        <div className="row wrap">
          {(tags ?? []).slice(0, 10).map(t => (
            <button key={t.id} type="button" className="tag-chip" style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => onChange([...value, t.id])}>
              <span className="swatch" style={{ background: t.color }} />
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function useSessions(options: { poll?: number } = {}) {
  return useApi<{ items: Session[]; defaultSessionId: string | null; dailyCap: number; gateway: { reachable: boolean; lastError: string | null } }>(
    '/api/sessions',
    options,
  );
}

export function SessionSelect({ value, onChange, allowDefault = false, id }: {
  value: string | null;
  onChange: (id: string | null) => void;
  allowDefault?: boolean;
  id?: string;
}) {
  const { data } = useSessions();
  const items = data?.items ?? [];
  return (
    <select id={id} className="select" value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
      {allowDefault && <option value="">Default number</option>}
      {!allowDefault && !value && <option value="">Choose a number…</option>}
      {items.map(s => (
        <option key={s.id} value={s.id}>
          {s.name}
          {s.phone ? ` · +${s.phone}` : ''}
          {s.status !== 'ready' ? ` (${s.status.replace('_', ' ')})` : ''}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------- segment rule builder

const FIELDS: Array<{ value: string; label: string }> = [
  { value: 'tag', label: 'Tag' },
  { value: 'consent', label: 'Consent' },
  { value: 'attribute', label: 'Custom field' },
  { value: 'name', label: 'Name' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'source', label: 'Source' },
  { value: 'wa_status', label: 'WhatsApp status' },
  { value: 'last_inbound_at', label: 'Last message from them' },
  { value: 'last_outbound_at', label: 'Last message to them' },
  { value: 'created_at', label: 'Added' },
  { value: 'campaign', label: 'Campaign engagement' },
];

const OPS: Record<string, Array<{ value: string; label: string }>> = {
  tag: [
    { value: 'has', label: 'has' },
    { value: 'not_has', label: 'does not have' },
  ],
  consent: [
    { value: 'is', label: 'is' },
    { value: 'is_not', label: 'is not' },
  ],
  wa_status: [
    { value: 'is', label: 'is' },
    { value: 'is_not', label: 'is not' },
  ],
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
    { value: 'starts_with', label: 'starts with' },
    { value: 'equals', label: 'equals' },
    { value: 'is_empty', label: 'is empty' },
    { value: 'is_not_empty', label: 'is not empty' },
  ],
  attribute: [
    { value: 'equals', label: 'equals' },
    { value: 'not_equals', label: 'does not equal' },
    { value: 'contains', label: 'contains' },
    { value: 'gt', label: 'is greater than' },
    { value: 'lt', label: 'is less than' },
    { value: 'is_not_empty', label: 'is set' },
    { value: 'is_empty', label: 'is not set' },
  ],
  date: [
    { value: 'within_days', label: 'within the last (days)' },
    { value: 'older_than_days', label: 'more than (days) ago' },
    { value: 'ever', label: 'ever' },
    { value: 'never', label: 'never' },
  ],
  campaign: [
    { value: 'sent', label: 'received' },
    { value: 'not_sent', label: 'did not receive' },
    { value: 'read', label: 'read' },
    { value: 'not_read', label: 'received but did not read' },
    { value: 'replied', label: 'replied to' },
    { value: 'not_replied', label: 'received but did not reply to' },
    { value: 'clicked', label: 'clicked a link in' },
  ],
};

function opsFor(field: string) {
  if (field === 'tag' || field === 'consent' || field === 'wa_status' || field === 'attribute' || field === 'campaign') return OPS[field];
  if (field.endsWith('_at')) return OPS.date;
  return OPS.text;
}

function defaultCondition(field: string): Condition {
  const op = opsFor(field)[0].value;
  if (field === 'consent') return { field, op, value: 'opted_in' };
  if (field === 'wa_status') return { field, op, value: 'valid' };
  if (field.endsWith('_at')) return { field, op, value: 30 };
  if (field === 'attribute') return { field, op, key: '', value: '' };
  return { field, op, value: field === 'tag' || field === 'campaign' ? undefined : '' };
}

function ConditionValue({ condition, onChange, tags, campaigns, attributeKeys }: {
  condition: Condition;
  onChange: (c: Condition) => void;
  tags: Tag[];
  campaigns: Campaign[];
  attributeKeys: string[];
}) {
  const { field, op } = condition;
  if (['is_empty', 'is_not_empty', 'ever', 'never'].includes(op)) return <span className="muted small">–</span>;
  if (field === 'tag') {
    return (
      <select className="select sm" value={condition.value ?? ''} onChange={e => onChange({ ...condition, value: Number(e.target.value) || undefined })}>
        <option value="">Choose tag…</option>
        {tags.map(t => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    );
  }
  if (field === 'campaign') {
    return (
      <select className="select sm" value={condition.value ?? ''} onChange={e => onChange({ ...condition, value: Number(e.target.value) || undefined })}>
        <option value="">Choose campaign…</option>
        {campaigns
          .filter(c => c.status !== 'draft')
          .map(c => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
    );
  }
  if (field === 'consent') {
    return (
      <select className="select sm" value={String(condition.value)} onChange={e => onChange({ ...condition, value: e.target.value })}>
        <option value="opted_in">Opted in</option>
        <option value="unknown">Unknown</option>
        <option value="opted_out">Opted out</option>
      </select>
    );
  }
  if (field === 'wa_status') {
    return (
      <select className="select sm" value={String(condition.value)} onChange={e => onChange({ ...condition, value: e.target.value })}>
        <option value="valid">On WhatsApp</option>
        <option value="invalid">Not on WhatsApp</option>
        <option value="unknown">Unverified</option>
      </select>
    );
  }
  if (field.endsWith('_at')) {
    return <input className="input sm" type="number" min={0} value={condition.value ?? ''} onChange={e => onChange({ ...condition, value: Number(e.target.value) })} />;
  }
  if (field === 'attribute') {
    return (
      <div className="row">
        <input
          className="input sm"
          list="attribute-keys"
          placeholder="field (e.g. city)"
          value={condition.key ?? ''}
          onChange={e => onChange({ ...condition, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_') })}
        />
        <datalist id="attribute-keys">
          {attributeKeys.map(k => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <input className="input sm" placeholder="value" value={String(condition.value ?? '')} onChange={e => onChange({ ...condition, value: e.target.value })} />
      </div>
    );
  }
  return <input className="input sm" value={String(condition.value ?? '')} onChange={e => onChange({ ...condition, value: e.target.value })} />;
}

export function RuleBuilder({ rules, onChange }: { rules: Rules; onChange: (rules: Rules) => void }) {
  const { data: tags } = useTags();
  const { data: campaigns } = useApi<Campaign[]>('/api/campaigns');
  const { data: attrs } = useApi<{ keys: string[] }>('/api/contacts/attributes');
  const update = (index: number, condition: Condition) => onChange({ ...rules, conditions: rules.conditions.map((c, i) => (i === index ? condition : c)) });
  return (
    <div className="stack">
      <div className="row wrap">
        <span>Contacts matching</span>
        <select className="select sm" style={{ width: 'auto' }} value={rules.match} onChange={e => onChange({ ...rules, match: e.target.value as Rules['match'] })}>
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        <span>of these conditions</span>
      </div>
      {rules.conditions.length === 0 && <p className="muted small">No conditions: every contact matches.</p>}
      {rules.conditions.map((condition, index) => (
        <div className="rule-row" key={index}>
          <select className="select sm" value={condition.field} onChange={e => update(index, defaultCondition(e.target.value))}>
            {FIELDS.map(f => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select className="select sm" value={condition.op} onChange={e => update(index, { ...condition, op: e.target.value })}>
            {opsFor(condition.field).map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ConditionValue condition={condition} onChange={c => update(index, c)} tags={tags ?? []} campaigns={campaigns ?? []} attributeKeys={attrs?.keys ?? []} />
          <Button
            size="sm"
            variant="ghost"
            icon={<IconX size={15} />}
            aria-label="Remove condition"
            onClick={() => onChange({ ...rules, conditions: rules.conditions.filter((_, i) => i !== index) })}
          />
        </div>
      ))}
      <div>
        <Button size="sm" icon={<IconPlus size={14} />} onClick={() => onChange({ ...rules, conditions: [...rules.conditions, defaultCondition('tag')] })}>
          Add condition
        </Button>
      </div>
    </div>
  );
}

/** Drop conditions the user has not finished filling in, so previews don't 400 mid-edit. */
export function completeRules(rules: Rules): Rules {
  return {
    match: rules.match,
    conditions: rules.conditions.filter(c => {
      if (['is_empty', 'is_not_empty', 'ever', 'never'].includes(c.op)) return c.field !== 'attribute' || !!c.key;
      if (c.field === 'attribute') return !!c.key;
      return c.value !== undefined && c.value !== '';
    }),
  };
}
