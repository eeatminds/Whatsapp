import { useRef, useState } from 'react';
import { post, useApi, errorMessage, type Media } from '../api';
import { formatBytes } from '../format';
import { Button, Empty, ErrorNote, Loading, Modal, useToast } from './ui';
import { IconFile, IconUpload, IconX } from './icons';

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;base64,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function MediaThumb({ media, size = 44 }: { media: Media; size?: number }) {
  if (media.kind === 'image') {
    return <img src={`/api/media/${media.id}/file`} alt="" style={{ width: size, height: size, borderRadius: 6, objectFit: 'cover' }} />;
  }
  return (
    <span style={{ width: size, height: size, display: 'grid', placeItems: 'center', borderRadius: 6, background: 'var(--surface-sunken)' }}>
      <IconFile size={size / 2.2} />
    </span>
  );
}

export function UploadButton({ onUploaded, label = 'Upload file' }: { onUploaded: (media: Media) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp,audio/mpeg,audio/ogg,audio/aac,audio/mp4,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
        onChange={async e => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          try {
            const base64 = await readFileAsBase64(file);
            const media = await post<Media>('/api/media', { filename: file.name, mimetype: file.type || 'application/octet-stream', base64 });
            onUploaded(media);
          } catch (error) {
            toast.error(errorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button icon={<IconUpload size={16} />} loading={busy} onClick={() => input.current?.click()}>
        {label}
      </Button>
    </>
  );
}

export function MediaPicker({ onPick, onClose, selectedId }: { onPick: (media: Media) => void; onClose: () => void; selectedId?: number | null }) {
  const { data, error, loading, reload } = useApi<Media[]>('/api/media');
  return (
    <Modal title="Media library" onClose={onClose} wide footer={<Button onClick={onClose}>Close</Button>}>
      <div className="row between wrap">
        <span className="secondary small">Images up to 5 MB, video and audio up to 16 MB, documents up to 30 MB.</span>
        <UploadButton
          onUploaded={media => {
            void reload();
            onPick(media);
          }}
        />
      </div>
      <ErrorNote error={error} />
      {loading && !data ? (
        <Loading />
      ) : data && data.length === 0 ? (
        <Empty title="No media yet">Upload an image, video, audio clip or PDF to attach it to messages.</Empty>
      ) : (
        <div className="media-grid">
          {data?.map(media => (
            <button key={media.id} type="button" className={`media-card ${selectedId === media.id ? 'selected' : ''}`} onClick={() => onPick(media)}>
              <div className="thumb">{media.kind === 'image' ? <img src={`/api/media/${media.id}/file`} alt="" /> : <IconFile size={28} />}</div>
              <div className="name" title={media.filename}>
                {media.filename}
              </div>
              <div className="name muted" style={{ paddingTop: 0 }}>
                {media.kind} · {formatBytes(media.size)}
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function AttachedMedia({ mediaId, onRemove }: { mediaId: number; onRemove?: () => void }) {
  const { data } = useApi<Media[]>('/api/media');
  const media = data?.find(m => m.id === mediaId);
  if (!media) return null;
  return (
    <div className="media-tile">
      <MediaThumb media={media} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{media.filename}</div>
        <div className="small muted">
          {media.kind} · {formatBytes(media.size)}
        </div>
      </div>
      {onRemove && <Button variant="ghost" size="sm" icon={<IconX size={15} />} aria-label="Remove attachment" onClick={onRemove} />}
    </div>
  );
}
