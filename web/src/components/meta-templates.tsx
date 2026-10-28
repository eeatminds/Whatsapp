import type { ReactNode } from 'react';
import type { MetaTemplate, MetaTemplateButton, TemplateDraft } from '../api';
import { Badge } from './ui';
import { WhatsAppText } from './composer';
import { IconCopy, IconFile, IconLink, IconPhone } from './icons';

// ---------------------------------------------------------------- status

export interface StatusInfo {
  label: string;
  tone?: 'green' | 'blue' | 'amber' | 'red';
  /** One line for the business: what the status means for sending. */
  meaning: string;
}

export function templateStatus(status: string): StatusInfo {
  switch (status) {
    case 'DRAFT':
      return { label: 'Draft', meaning: 'Only saved in WA Reach. Submit it to Meta for review when it is ready.' };
    case 'PENDING':
      return { label: 'In review', tone: 'amber', meaning: 'Meta is reviewing it: usually a few minutes, at most 24 hours. The status here updates by itself.' };
    case 'IN_APPEAL':
      return { label: 'Appeal in review', tone: 'amber', meaning: 'Meta is looking at your appeal (up to 24 hours).' };
    case 'APPROVED':
      return { label: 'Approved', tone: 'green', meaning: 'Ready to use in campaigns and drips.' };
    case 'REJECTED':
      return { label: 'Rejected', tone: 'red', meaning: 'Meta did not approve it. Fix it below and submit again.' };
    case 'PAUSED':
      return {
        label: 'Paused',
        tone: 'amber',
        meaning: 'Meta paused it because customers blocked, reported or ignored it. It restarts on its own after a few hours; improving the wording helps.',
      };
    case 'DISABLED':
      return { label: 'Disabled', tone: 'red', meaning: 'Meta disabled it after repeated complaints. Make a new, improved template instead.' };
    case 'ARCHIVED':
      return { label: 'Archived', meaning: 'Not used for a year, so Meta archived it.' };
    case 'PENDING_DELETION':
      return { label: 'Being deleted', meaning: 'Deleted in WhatsApp Manager; messages already sent are still delivered.' };
    default:
      return { label: status.toLowerCase().replace(/_/g, ' '), meaning: '' };
  }
}

export function qualityInfo(quality: string | null): { label: string; tone?: 'green' | 'amber' | 'red' } | null {
  switch (quality) {
    case 'GREEN':
      return { label: 'High quality', tone: 'green' };
    case 'YELLOW':
      return { label: 'Medium quality', tone: 'amber' };
    case 'RED':
      return { label: 'Low quality', tone: 'red' };
    case 'UNKNOWN':
    case null:
    case undefined:
      return { label: 'Quality pending' };
    default:
      return null;
  }
}

/** Meta's rejection reasons in plain words, with what to change. */
export function rejectionHelp(reason: string | null): { why: string; fix: string } | null {
  switch (reason) {
    case 'INVALID_FORMAT':
      return {
        why: 'Something in the layout broke Meta’s rules.',
        fix: 'Common causes: a blank at the very start or end, two blanks side by side, too many blanks for the text, or a missing example. The checks in the editor point these out.',
      };
    case 'INCORRECT_CATEGORY':
    case 'TAG_CONTENT_MISMATCH':
      return {
        why: 'The wording doesn’t match the category chosen.',
        fix: 'Choose Marketing for offers, news and invitations. Utility is only for updates about something the customer already did (an order, booking or payment).',
      };
    case 'PROMOTIONAL':
      return { why: 'It promotes something but was sent as Utility.', fix: 'Change the category to Marketing, or remove the offer wording.' };
    case 'ABUSIVE_CONTENT':
      return { why: 'Meta found wording that breaks its policies.', fix: 'Remove anything that could read as threatening, pressuring, adult or offensive.' };
    case 'SCAM':
      return { why: 'Meta thinks it could mislead customers.', fix: 'Avoid unrealistic prizes, urgent payment requests and links to unknown websites. Say clearly who you are.' };
    case null:
    case undefined:
    case '':
      return null;
    default:
      return { why: `Meta’s reason: ${reason.toLowerCase().replace(/_/g, ' ')}.`, fix: 'Change the template and submit it again.' };
  }
}

export function StatusBadges({ template }: { template: Pick<MetaTemplate, 'status' | 'quality'> }) {
  const status = templateStatus(template.status);
  const quality = template.status === 'APPROVED' ? qualityInfo(template.quality) : null;
  return (
    <span className="row" style={{ gap: 6 }}>
      <Badge tone={status.tone} dot>
        {status.label}
      </Badge>
      {quality && <Badge tone={quality.tone}>{quality.label}</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------- preview

interface PreviewButton {
  type: string;
  text: string;
}
interface PreviewCard {
  media: { kind: string; url: string | null };
  body: string;
  buttons: PreviewButton[];
}
export interface PreviewModel {
  header: { kind: 'none' | 'text' | 'image' | 'video' | 'document' | 'location'; text?: string; url?: string | null };
  offer: { text: string; expires: boolean } | null;
  body: string;
  footer: string;
  buttons: PreviewButton[];
  cards: PreviewCard[];
}

const BLANK = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** What a draft looks like with its example values filled in. */
export function previewOfDraft(draft: TemplateDraft): PreviewModel {
  const fill = (text: string) => text.replace(BLANK, (m, name: string) => draft.samples[name]?.trim() || m);
  const mediaUrl = (id: number | null) => (id ? `/api/media/${id}/file` : null);
  const buttonText = (b: TemplateDraft['buttons'][number]): PreviewButton =>
    b.type === 'copy_code' ? { type: 'COPY_CODE', text: 'Copy offer code' } : { type: b.type === 'quick_reply' ? 'QUICK_REPLY' : b.type === 'url' ? 'URL' : 'PHONE_NUMBER', text: b.text || 'Button' };
  return {
    header: { kind: draft.format === 'carousel' ? 'none' : draft.header.type, text: fill(draft.header.text), url: mediaUrl(draft.header.mediaId) },
    offer: draft.format === 'offer' ? draft.offer : null,
    body: fill(draft.body),
    footer: draft.format === 'standard' ? draft.footer : '',
    buttons: draft.format === 'carousel' ? [] : draft.buttons.map(buttonText),
    cards:
      draft.format === 'carousel'
        ? draft.cards.map(card => ({ media: { kind: draft.cardFormat, url: mediaUrl(card.mediaId) }, body: fill(card.body), buttons: card.buttons.map(buttonText) }))
        : [],
  };
}

/** What a template from Meta looks like, with the business's (or example) values. */
export function previewOfTemplate(template: MetaTemplate, params: Record<string, string> = {}, media: { header?: number | null; cards?: Array<number | null> } = {}): PreviewModel {
  const fill = (text: string | null, part: string) => (text ?? '').replace(BLANK, (m, name: string) => params[`${part}:${name}`]?.trim() || m);
  const url = (id: number | null | undefined) => (id ? `/api/media/${id}/file` : null);
  const toButtons = (buttons: MetaTemplateButton[]) => buttons.map(b => ({ type: b.type, text: b.text || (b.type === 'COPY_CODE' ? 'Copy offer code' : 'Button') }));
  return {
    header: { kind: (template.headerFormat.toLowerCase() as PreviewModel['header']['kind']) ?? 'none', text: fill(template.headerText, 'header'), url: url(media.header) },
    offer: template.offer ? { text: template.offer.text, expires: template.offer.hasExpiration } : null,
    body: fill(template.bodyText, 'body'),
    footer: template.footerText ?? '',
    buttons: toButtons(template.buttons),
    cards: template.cards.map((card, i) => ({
      media: { kind: card.headerFormat.toLowerCase(), url: url(media.cards?.[i]) },
      body: fill(card.bodyText, `card:${i}:body`),
      buttons: toButtons(card.buttons),
    })),
  };
}

function ButtonIcon({ type }: { type: string }) {
  if (type === 'URL') return <IconLink size={14} />;
  if (type === 'PHONE_NUMBER' || type === 'VOICE_CALL') return <IconPhone size={14} />;
  if (type === 'COPY_CODE') return <IconCopy size={14} />;
  return <span aria-hidden="true">↩</span>;
}

function MediaBox({ kind, url }: { kind: string; url?: string | null }): ReactNode {
  if (kind === 'image' && url) return <img className="tpl-media" src={url} alt="" />;
  if (kind === 'video' && url) return <video className="tpl-media" src={url} muted preload="metadata" />;
  if (kind === 'document') {
    return (
      <div className="tpl-doc">
        <IconFile size={18} /> Document
      </div>
    );
  }
  if (kind === 'location') return <div className="tpl-media tpl-map">📍 Map of the place you choose</div>;
  return <div className="tpl-media tpl-placeholder">{kind === 'video' ? '🎬 Video' : '🖼️ Image'}</div>;
}

function Buttons({ buttons }: { buttons: PreviewButton[] }) {
  if (!buttons.length) return null;
  const shown = buttons.length > 3 ? buttons.slice(0, 2) : buttons;
  return (
    <div className="tpl-buttons">
      {shown.map((b, i) => (
        <div key={i} className="tpl-button">
          <ButtonIcon type={b.type} /> {b.text}
        </div>
      ))}
      {buttons.length > 3 && <div className="tpl-button">☰ See all options</div>}
    </div>
  );
}

/** A phone-style preview of a template, as the customer sees it. */
export function TemplatePreview({ model }: { model: PreviewModel }) {
  const empty = !model.body.trim() && model.header.kind === 'none';
  return (
    <div className="wa-preview tpl-preview" aria-label="Template preview">
      {empty ? (
        <span className="muted small" style={{ margin: 'auto' }}>
          Your template preview appears here
        </span>
      ) : (
        <div className="tpl-message">
          <div className="bubble in tpl-bubble">
            {model.header.kind === 'text' && model.header.text && <strong className="tpl-header-text">{model.header.text}</strong>}
            {model.header.kind !== 'none' && model.header.kind !== 'text' && <MediaBox kind={model.header.kind} url={model.header.url} />}
            {model.offer && (
              <div className="tpl-offer">
                <strong>🏷️ {model.offer.text || 'Offer headline'}</strong>
                {model.offer.expires && <span className="small muted">Ends in 2 days</span>}
              </div>
            )}
            {model.body && <WhatsAppText text={model.body} />}
            {model.footer && <span className="tpl-footer">{model.footer}</span>}
            <span className="meta">10:24</span>
          </div>
          <Buttons buttons={model.buttons} />
          {model.cards.length > 0 && (
            <div className="tpl-cards">
              {model.cards.map((card, i) => (
                <div key={i} className="tpl-card">
                  <MediaBox kind={card.media.kind} url={card.media.url} />
                  {card.body && (
                    <div className="tpl-card-body">
                      <WhatsAppText text={card.body} />
                    </div>
                  )}
                  <Buttons buttons={card.buttons} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
