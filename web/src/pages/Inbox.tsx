import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { post, useApi, errorMessage, type Contact, type Conversation, type Message } from '../api';
import { Button, Callout, Card, ConsentBadge, Empty, Loading, PageHeader, Segmented, useToast } from '../components/ui';
import { IconArrowLeft, IconCheck, IconChecks, IconPaperclip, IconSearch, IconSend } from '../components/icons';
import { Bubble } from '../components/composer';
import { AttachedMedia, MediaPicker } from '../components/media';
import { displayName, formatPhone, formatTime, initials, relativeTime } from '../format';

const SOURCE_LABEL: Record<string, string> = {
  campaign: 'Campaign',
  sequence: 'Drip sequence',
  auto_reply: 'Auto-reply',
  system: 'Automatic',
  test: 'Test send',
  manual: '',
};

function Ticks({ status }: { status: string }) {
  if (status === 'read') return <IconChecks size={14} style={{ color: '#34b7f1' }} aria-label="Read" />;
  if (status === 'delivered') return <IconChecks size={14} aria-label="Delivered" />;
  if (status === 'failed') return <span className="error-text" aria-label="Failed">!</span>;
  return <IconCheck size={14} aria-label="Sent" />;
}

function Thread({ contactId, onBack }: { contactId: number; onBack: () => void }) {
  const { data, reload } = useApi<{ contact: Contact; messages: Message[]; sessionId: string | null; official: { windowOpenUntil: string | null } | null }>(`/api/inbox/${contactId}`, { poll: 5000 });
  const [text, setText] = useState('');
  const [mediaId, setMediaId] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const count = data?.messages.length ?? 0;

  useEffect(() => {
    void post(`/api/inbox/${contactId}/seen`).catch(() => undefined);
  }, [contactId, count]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  if (!data) return <Loading />;
  const { contact } = data;

  const send = async () => {
    setBusy(true);
    try {
      await post(`/api/inbox/${contactId}/send`, { text, mediaId });
      setText('');
      setMediaId(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  let lastDay = '';
  return (
    <div className="thread">
      <div className="card-header">
        <div className="row">
          <button type="button" className="btn ghost icon sm" aria-label="Back to conversations" onClick={onBack}>
            <IconArrowLeft size={16} />
          </button>
          <span className="avatar">{initials(contact.name, contact.phone)}</span>
          <div>
            <strong>{displayName(contact)}</strong>
            <div className="small secondary">{formatPhone(contact.phone)}</div>
          </div>
        </div>
        <div className="row wrap">
          <ConsentBadge consent={contact.consent} />
          {contact.tags.slice(0, 3).map(t => (
            <span key={t.id} className="tag-chip">
              <span className="swatch" style={{ background: t.color }} />
              {t.name}
            </span>
          ))}
        </div>
      </div>
      <div className="wa-preview thread-messages">
        {data.messages.length === 0 && <span className="muted small" style={{ margin: 'auto' }}>No messages yet. Say hello below.</span>}
        {data.messages.map(m => {
          const day = new Date(m.createdAt).toDateString();
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id} className="stack tight" style={{ gap: 6 }}>
              {showDay && (
                <span className="badge" style={{ alignSelf: 'center', background: 'var(--surface)' }}>
                  {new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                </span>
              )}
              <Bubble
                text={m.body ?? (m.type !== 'text' ? `[${m.type}]` : '')}
                mediaId={m.direction === 'out' ? m.mediaId : null}
                direction={m.direction}
                time={formatTime(m.createdAt)}
                label={m.direction === 'out' ? SOURCE_LABEL[m.sourceType] || undefined : undefined}
                status={m.direction === 'out' ? <Ticks status={m.status} /> : undefined}
              />
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      {data.official && (
        <div style={{ padding: '8px 12px 0' }}>
          {data.official.windowOpenUntil ? (
            <p className="hint" style={{ margin: 0 }}>
              Official number: you can reply freely until {new Date(data.official.windowOpenUntil).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (24 hours after their last message).
            </p>
          ) : (
            <Callout tone="warn">
              The 24-hour reply window is closed. WhatsApp only lets official numbers message this customer with an approved template now: send them a campaign, or wait until they message you.
            </Callout>
          )}
        </div>
      )}
      {contact.consent === 'opted_out' && (
        <div style={{ padding: '8px 12px 0' }}>
          <Callout tone="warn">This contact opted out of marketing. Replying to their questions is fine; don't send promotions.</Callout>
        </div>
      )}
      {mediaId && (
        <div style={{ padding: '8px 12px 0' }}>
          <AttachedMedia mediaId={mediaId} onRemove={() => setMediaId(null)} />
        </div>
      )}
      <form
        className="thread-compose"
        onSubmit={e => {
          e.preventDefault();
          if (text.trim() || mediaId) void send();
        }}
      >
        <Button icon={<IconPaperclip size={16} />} aria-label="Attach media" onClick={() => setPicking(true)} />
        <textarea
          className="textarea"
          rows={1}
          value={text}
          placeholder="Type a reply"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (text.trim() || mediaId) void send();
            }
          }}
        />
        <Button type="submit" variant="primary" icon={<IconSend size={16} />} loading={busy} disabled={!text.trim() && !mediaId} aria-label="Send" />
      </form>
      {picking && (
        <MediaPicker
          onClose={() => setPicking(false)}
          onPick={m => {
            setMediaId(m.id);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

export function InboxPage() {
  const { contactId } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'unread' | 'replied'>('all');
  const [q, setQ] = useState('');
  const query = new URLSearchParams({ ...(q ? { q } : {}), view: filter }).toString();
  const { data, loading } = useApi<{ items: Conversation[]; unread: number }>(`/api/inbox?${query}`, { poll: 8000 });
  const selected = contactId ? Number(contactId) : null;

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <PageHeader title="Inbox" description="Every chat with your contacts: messages you send and the replies you get." />
      <Card bodyClass="">
        <div className={`inbox ${selected ? 'has-thread' : ''}`}>
          <div className="inbox-list">
            <div className="stack tight" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ position: 'relative' }}>
                <IconSearch size={16} style={{ position: 'absolute', left: 10, color: 'var(--text-muted)' }} />
                <input className="input sm" style={{ paddingLeft: 32 }} placeholder="Search" value={q} onChange={e => setQ(e.target.value)} aria-label="Search conversations" />
              </div>
              <Segmented
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'unread', label: `Unread${data?.unread ? ` (${data.unread})` : ''}` },
                  { value: 'replied', label: 'Replied' },
                ]}
              />
            </div>
            {loading && !data ? (
              <Loading />
            ) : data?.items.length === 0 ? (
              <Empty title={filter === 'unread' ? 'All caught up' : filter === 'replied' ? 'No replies yet' : 'No conversations yet'}>
                {filter === 'unread'
                  ? ''
                  : filter === 'replied'
                    ? 'Contacts who write back to you appear here.'
                    : 'Messages you send and replies you receive appear here.'}
              </Empty>
            ) : (
              data?.items.map(c => (
                <button key={c.contactId} type="button" className={`inbox-item ${selected === c.contactId ? 'active' : ''}`} onClick={() => navigate(`/inbox/${c.contactId}`)}>
                  <span className="avatar">{initials(c.name, c.phone)}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="row between">
                      <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(c)}</strong>
                      <span className="small muted nowrap">{relativeTime(c.lastAt)}</span>
                    </span>
                    <span className="row between">
                      <span className="small secondary" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.lastDirection === 'out' ? 'You: ' : ''}
                        {c.lastMessage}
                      </span>
                      {c.unread > 0 && <span className="nav-link" style={{ padding: 0 }}><span className="count">{c.unread}</span></span>}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          {selected ? (
            <Thread key={selected} contactId={selected} onBack={() => navigate('/inbox')} />
          ) : (
            <div className="thread" style={{ display: 'grid', placeItems: 'center' }}>
              <Empty title="Select a conversation">See what you sent, delivery and read ticks, and reply to your contacts.</Empty>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
