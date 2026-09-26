import { useState } from 'react';
import { del, patch, post, useApi, errorMessage, type Template } from '../api';
import { Button, Callout, Card, Empty, ErrorNote, Field, Loading, Modal, PageHeader, useConfirm, useToast } from '../components/ui';
import { IconPlus } from '../components/icons';
import { Composer, MessagePreview, WhatsAppText } from '../components/composer';
import { relativeTime } from '../format';

function TemplateEditor({ template, onClose, onSaved }: { template: Template | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(template?.name ?? '');
  const [message, setMessage] = useState({ body: template?.body ?? '', mediaId: template?.mediaId ?? null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, body: message.body, mediaId: message.mediaId };
      if (template) await patch(`/api/templates/${template.id}`, body);
      else await post('/api/templates', body);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={template ? 'Edit template' : 'New template'}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || (!message.body.trim() && !message.mediaId)} onClick={save}>
            Save template
          </Button>
        </>
      }
    >
      <ErrorNote error={error} />
      <Field label="Name">
        <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Festive offer" />
      </Field>
      <div className="grid cols-2">
        <Composer body={message.body} mediaId={message.mediaId} onChange={setMessage} allowTemplates={false} />
        <MessagePreview body={message.body} mediaId={message.mediaId} />
      </div>
    </Modal>
  );
}

export function TemplatesPage() {
  const { data, error, loading, reload } = useApi<Template[]>('/api/templates');
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  return (
    <div className="page">
      <PageHeader
        title="Templates"
        description="Reusable messages with personalization and media. Load them into any campaign, drip step or reply."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setEditing('new')}>
            New template
          </Button>
        }
      />
      <ErrorNote error={error} />
      {data?.some(t => t.body.includes('[')) && (
        <Callout tone="success">
          Starter templates for common messages are included. Replace the text in [square brackets] with your details before sending.{' '}
          {'{{first_name}}'} and {'{{business_name}}'} fill in automatically for each customer.
        </Callout>
      )}
      {loading && !data ? (
        <Loading />
      ) : data?.length === 0 ? (
        <Card>
          <Empty title="No templates yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Write a template</Button>}>
            Save the messages you send often: offers, reminders, order updates, festival greetings.
          </Empty>
        </Card>
      ) : (
        <div className="grid cols-3">
          {data?.map(t => (
            <Card
              key={t.id}
              title={t.name}
              subtitle={`Updated ${relativeTime(t.updatedAt)}`}
              footer={
                <div className="row">
                  <Button size="sm" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <span className="spacer" />
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (!(await confirm(`Delete “${t.name}”?`, 'Campaigns that already used it keep their own copy.', { confirmLabel: 'Delete', danger: true }))) return;
                      try {
                        await del(`/api/templates/${t.id}`);
                        void reload();
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              }
            >
              <div className="secondary" style={{ whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'hidden', fontSize: 13.5 }}>
                {t.mediaId ? '📎 ' : ''}
                <WhatsAppText text={t.body} />
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && <TemplateEditor template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      {dialog}
    </div>
  );
}
