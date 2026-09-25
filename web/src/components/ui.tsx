import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconAlert, IconInfo, IconX } from './icons';
import type { Consent, Tag, WaStatus } from '../api';

// ---------------------------------------------------------------- toasts

type ToastKind = 'success' | 'error';
const ToastContext = createContext<{ show: (message: string, kind?: ToastKind) => void }>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; kind: ToastKind }>>([]);
  const show = useCallback((message: string, kind: ToastKind = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(list => [...list, { id, message, kind }]);
    setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const { show } = useContext(ToastContext);
  return {
    success: (message: string) => show(message, 'success'),
    error: (message: string) => show(message, 'error'),
  };
}

// ---------------------------------------------------------------- basics

export function Button({
  variant,
  size,
  icon,
  loading,
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'danger' | 'ghost';
  size?: 'sm';
  icon?: ReactNode;
  loading?: boolean;
}) {
  const classes = ['btn', variant, size, !children && icon ? 'icon' : '', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={classes} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : icon}
      {children}
    </button>
  );
}

export function Card({ title, subtitle, actions, children, footer, bodyClass = 'card-body', className = '' }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  bodyClass?: string;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="row wrap">{actions}</div>}
        </div>
      )}
      {children !== undefined && <div className={bodyClass}>{children}</div>}
      {footer && <div className="card-footer">{footer}</div>}
    </section>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="stack tight">
        {back}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </header>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/**
 * A number box you can clear and retype freely: the value is only clamped to [min, max] when you
 * leave the field, so typing "1" over "6" gives 1 rather than jumping to "11" or back to the old value.
 */
export function NumberInput({ value, onChange, min, max, className = 'input' }: { value: number; onChange: (n: number) => void; min: number; max: number; className?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(current => (Number(current) === value && current !== '' ? current : String(value))), [value]);
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  return (
    <input
      className={className}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={draft}
      onChange={e => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n) && n >= min && n <= max) onChange(Math.round(n));
      }}
      onBlur={() => {
        const n = Number(draft);
        const next = draft === '' || !Number.isFinite(n) ? value : clamp(n);
        setDraft(String(next));
        if (next !== value) onChange(next);
      }}
    />
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="toggle" style={{ alignItems: description ? 'flex-start' : 'center', opacity: disabled ? 0.6 : 1 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="track" style={{ marginTop: description ? 2 : 0 }} />
      <span className="stack tight" style={{ gap: 2 }}>
        <span style={{ fontWeight: 550 }}>{label}</span>
        {description && <span className="hint">{description}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map(o => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} className={value === t.value ? 'active' : ''} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ tone, children, dot }: { tone?: 'green' | 'blue' | 'amber' | 'red'; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge ${tone ?? ''}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function TagChip({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  return (
    <span className="tag-chip">
      <span className="swatch" style={{ background: tag.color }} />
      {tag.name}
      {onRemove && (
        <button type="button" aria-label={`Remove ${tag.name}`} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}

export function ConsentBadge({ consent }: { consent: Consent }) {
  if (consent === 'opted_in') return <Badge tone="green" dot>Opted in</Badge>;
  if (consent === 'opted_out') return <Badge tone="red" dot>Opted out</Badge>;
  return <Badge dot>Unknown</Badge>;
}

export function WaBadge({ status, pending }: { status: WaStatus; pending?: boolean }) {
  if (pending) return <Badge tone="blue">Checking…</Badge>;
  if (status === 'valid') return <Badge tone="green">On WhatsApp</Badge>;
  if (status === 'invalid') return <Badge tone="red">Not on WhatsApp</Badge>;
  return <Badge>Unverified</Badge>;
}

export function Spinner() {
  return <span className="spinner" role="progressbar" aria-label="Loading" />;
}

export function Loading() {
  return (
    <div className="loading-block">
      <Spinner />
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Callout({ tone, children }: { tone?: 'warn' | 'danger' | 'success'; children: ReactNode }) {
  return (
    <div className={`callout ${tone ?? ''}`}>
      {tone === 'warn' || tone === 'danger' ? <IconAlert size={16} /> : <IconInfo size={16} />}
      <div>{children}</div>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <Callout tone="danger">{error}</Callout>;
}

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="row between" style={{ padding: '10px 14px' }}>
      <span className="muted small">
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total.toLocaleString()}
      </span>
      <div className="row">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- overlays

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([aria-label="Close"])')?.focus();
  }, []);
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" icon={<IconX size={16} />} aria-label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEscape(onClose);
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" icon={<IconX size={16} />} aria-label="Close" onClick={onClose} />
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="modal-footer" style={{ borderRadius: 0 }}>{footer}</div>}
      </aside>
    </>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{ title: string; message: ReactNode; confirmLabel: string; danger: boolean; resolve: (ok: boolean) => void } | null>(null);
  const confirm = (title: string, message: ReactNode, options: { confirmLabel?: string; danger?: boolean } = {}) =>
    new Promise<boolean>(resolve => setState({ title, message, confirmLabel: options.confirmLabel ?? 'Confirm', danger: options.danger ?? false, resolve }));
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  const dialog = state ? (
    <Modal
      title={state.title}
      onClose={() => close(false)}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={state.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {state.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="secondary">{state.message}</div>
    </Modal>
  ) : null;
  return { confirm, dialog };
}
