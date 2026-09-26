import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { post, useApi, type Media, type Template } from '../api';
import { Button, Modal } from './ui';
import { AttachedMedia, MediaPicker } from './media';
import { IconFile, IconPaperclip, IconTemplate } from './icons';

/** Render WhatsApp's lightweight markup (*bold* _italic_ ~strike~ ```mono```) as React nodes. */
export function WhatsAppText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  // {{placeholders}} are matched first and shown as-is, so the underscore in {{first_name}} isn't read as italics.
  const pattern = /(\{\{[^{}\n]*\}\})|```([\s\S]+?)```|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(<Fragment key={key++}>{text.slice(last, match.index)}</Fragment>);
    if (match[1] !== undefined) nodes.push(<Fragment key={key++}>{match[1]}</Fragment>);
    else if (match[2] !== undefined) nodes.push(<code key={key++}>{match[2]}</code>);
    else if (match[3] !== undefined) nodes.push(<strong key={key++}>{match[3]}</strong>);
    else if (match[4] !== undefined) nodes.push(<em key={key++}>{match[4]}</em>);
    else if (match[5] !== undefined) nodes.push(<s key={key++}>{match[5]}</s>);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{nodes}</>;
}

function useMedia(mediaId: number | null | undefined): Media | undefined {
  const { data } = useApi<Media[]>(mediaId ? '/api/media' : null);
  return data?.find(m => m.id === mediaId);
}

export function Bubble({ text, mediaId, direction = 'out', time, label, status }: {
  text: string;
  mediaId?: number | null;
  direction?: 'in' | 'out';
  time?: string;
  label?: string;
  status?: ReactNode;
}) {
  const media = useMedia(mediaId);
  return (
    <div className={`bubble ${direction}`}>
      {label && <span className="source">{label}</span>}
      {media?.kind === 'image' && <img className="media" src={`/api/media/${media.id}/file`} alt="" />}
      {media && media.kind !== 'image' && (
        <div className="doc">
          <IconFile size={18} /> {media.filename}
        </div>
      )}
      {text && <WhatsAppText text={text} />}
      <span className="meta">
        {time}
        {status}
      </span>
    </div>
  );
}

/** A phone-style preview of the rendered message, personalized for sample data by the server. */
export function MessagePreview({ body, mediaId, footer }: { body: string; mediaId?: number | null; footer?: string | null }) {
  const [rendered, setRendered] = useState<{ text: string; missing: string[] }>({ text: body, missing: [] });
  useEffect(() => {
    const timer = setTimeout(() => {
      post<{ text: string; missing: string[] }>('/api/templates/preview', { body })
        .then(setRendered)
        .catch(() => setRendered({ text: body, missing: [] }));
    }, 250);
    return () => clearTimeout(timer);
  }, [body]);
  const empty = !body.trim() && !mediaId;
  const text = footer ? (rendered.text.trim() ? `${rendered.text.trimEnd()}\n\n${footer}` : footer) : rendered.text;
  return (
    <div className="stack tight">
      <div className="wa-preview" aria-label="Message preview">
        {!empty ? <Bubble text={text} mediaId={mediaId} time="10:24" /> : <span className="muted small" style={{ margin: 'auto' }}>Your message preview appears here</span>}
      </div>
      <span className="hint">
        Preview uses sample data (Priya Sharma, Bengaluru).
        {rendered.missing.length > 0 && (
          <>
            {' '}
            Not every contact has <code>{rendered.missing.join(', ')}</code>: add a fallback like <code>{`{{${rendered.missing[0]}|there}}`}</code>.
          </>
        )}
      </span>
    </div>
  );
}

const BUILT_IN_VARS = ['first_name', 'name', 'last_name', 'phone', 'email', 'business_name'];

/**
 * Message editor: WhatsApp formatting buttons, personalization variables (built-ins plus every
 * attribute found on contacts), media attachment and template loading.
 */
export function Composer({
  body,
  mediaId,
  onChange,
  allowTemplates = true,
  allowMedia = true,
  rows = 7,
  placeholder = 'Hi {{first_name|there}}, …',
}: {
  body: string;
  mediaId?: number | null;
  onChange: (next: { body: string; mediaId: number | null }) => void;
  allowTemplates?: boolean;
  allowMedia?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [picking, setPicking] = useState(false);
  const [choosingTemplate, setChoosingTemplate] = useState(false);
  const { data: attrs } = useApi<{ keys: string[] }>('/api/contacts/attributes');
  const variables = [...BUILT_IN_VARS, ...(attrs?.keys ?? []).filter(k => !BUILT_IN_VARS.includes(k))];

  const insert = (before: string, after = '') => {
    const el = ref.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const selected = body.slice(start, end);
    const next = body.slice(0, start) + before + selected + after + body.slice(end);
    onChange({ body: next, mediaId: mediaId ?? null });
    requestAnimationFrame(() => {
      el?.focus();
      const cursor = start + before.length + selected.length + (selected ? after.length : 0);
      el?.setSelectionRange(cursor, cursor);
    });
  };

  const limit = mediaId ? 1024 : 4096;

  return (
    <div className="stack tight">
      <div className="row between wrap">
        <div className="toolbar" aria-label="Formatting">
          <Button size="sm" variant="ghost" aria-label="Bold" title="Bold" onClick={() => insert('*', '*')}>
            <strong>B</strong>
          </Button>
          <Button size="sm" variant="ghost" aria-label="Italic" title="Italic" onClick={() => insert('_', '_')}>
            <em>I</em>
          </Button>
          <Button size="sm" variant="ghost" aria-label="Strikethrough" title="Strikethrough" onClick={() => insert('~', '~')}>
            <s>S</s>
          </Button>
          <Button size="sm" variant="ghost" aria-label="Monospace" title="Monospace" onClick={() => insert('```', '```')}>
            <code>{'</>'}</code>
          </Button>
        </div>
        <div className="row">
          {allowTemplates && (
            <Button size="sm" icon={<IconTemplate size={15} />} onClick={() => setChoosingTemplate(true)}>
              Use template
            </Button>
          )}
          {allowMedia && (
            <Button size="sm" icon={<IconPaperclip size={15} />} onClick={() => setPicking(true)}>
              {mediaId ? 'Change media' : 'Attach media'}
            </Button>
          )}
        </div>
      </div>
      <textarea
        ref={ref}
        className="textarea"
        rows={rows}
        value={body}
        placeholder={placeholder}
        maxLength={4000}
        onChange={e => onChange({ body: e.target.value, mediaId: mediaId ?? null })}
      />
      <div className="row between wrap">
        <div className="var-chips" aria-label="Insert variable">
          {variables.slice(0, 16).map(v => (
            <button key={v} type="button" onClick={() => insert(`{{${v}}}`)} title={`Insert {{${v}}}`}>
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        <span className={`small ${body.length > limit ? 'error-text' : 'muted'}`}>
          {body.length}/{limit}
          {mediaId ? ' (caption)' : ''}
        </span>
      </div>
      {mediaId ? <AttachedMedia mediaId={mediaId} onRemove={() => onChange({ body, mediaId: null })} /> : null}
      {picking && (
        <MediaPicker
          selectedId={mediaId}
          onClose={() => setPicking(false)}
          onPick={media => {
            onChange({ body, mediaId: media.id });
            setPicking(false);
          }}
        />
      )}
      {choosingTemplate && (
        <TemplateChooser
          onClose={() => setChoosingTemplate(false)}
          onPick={t => {
            onChange({ body: t.body, mediaId: t.mediaId });
            setChoosingTemplate(false);
          }}
        />
      )}
    </div>
  );
}

function TemplateChooser({ onPick, onClose }: { onPick: (t: Template) => void; onClose: () => void }) {
  const { data } = useApi<Template[]>('/api/templates');
  return (
    <Modal title="Use a template" onClose={onClose}>
      {data?.length === 0 && <p className="secondary">No templates yet. Create them under Templates.</p>}
      <div className="stack tight">
        {data?.map(t => (
          <button key={t.id} type="button" className="option-card" onClick={() => onPick(t)} style={{ textAlign: 'left', font: 'inherit', color: 'inherit' }}>
            <div className="stack tight" style={{ gap: 2, minWidth: 0 }}>
              <strong>{t.name}</strong>
              <span className="small secondary" style={{ whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>
                {t.body || (t.mediaId ? '[media only]' : '')}
              </span>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}
