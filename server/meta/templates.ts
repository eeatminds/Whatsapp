/**
 * Meta message templates: which values a template needs ("slots"), and how to turn a business's
 * choices for those slots into the Cloud API send payload plus a readable copy for the inbox.
 *
 * Templates use positional ({{1}}, {{2}}) or named ({{first_name}}) placeholders. A slot key names
 * where the value goes: "header:1", "body:first_name", "button:0:1" (URL button suffix) or
 * "button:1:coupon" (copy-code button).
 */
import type { MetaTemplateComponent } from './client.js';

export interface TemplateSlot {
  key: string;
  label: string;
  /** Where the value appears, for the editor's help text. */
  hint: string;
}

export interface TemplateButton {
  type: string;
  text: string;
  url?: string;
}

export interface TemplateShape {
  supported: boolean;
  reason: string | null;
  headerFormat: string;
  headerText: string | null;
  bodyText: string;
  footerText: string | null;
  buttons: TemplateButton[];
  slots: TemplateSlot[];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const MEDIA_HEADERS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);
const SIMPLE_BUTTONS = new Set(['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE']);

/** Placeholder names in order; positional ones sorted by number, as the API expects them. */
function placeholders(text: string | null | undefined): string[] {
  if (!text) return [];
  const names = [...new Set([...text.matchAll(PLACEHOLDER)].map(m => m[1]))];
  return names.every(n => /^\d+$/.test(n)) ? names.sort((a, b) => Number(a) - Number(b)) : names;
}

export function describeTemplate(components: MetaTemplateComponent[] | undefined, category?: string | null): TemplateShape {
  const list = components ?? [];
  const header = list.find(c => c.type?.toUpperCase() === 'HEADER');
  const body = list.find(c => c.type?.toUpperCase() === 'BODY');
  const footer = list.find(c => c.type?.toUpperCase() === 'FOOTER');
  const buttonsComponent = list.find(c => c.type?.toUpperCase() === 'BUTTONS');
  const headerFormat = header ? (header.format ?? 'TEXT').toUpperCase() : 'NONE';
  const buttons: TemplateButton[] = (buttonsComponent?.buttons ?? []).map(b => ({ type: (b.type ?? '').toUpperCase(), text: b.text ?? '', url: b.url }));

  let reason: string | null = null;
  const unknown = list.find(c => !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(c.type?.toUpperCase()));
  if ((category ?? '').toUpperCase() === 'AUTHENTICATION') reason = 'Authentication (one-time code) templates are not for marketing';
  else if (unknown) reason = `${unknown.type.toLowerCase().replace(/_/g, ' ')} templates are not supported yet`;
  else if (headerFormat === 'LOCATION') reason = 'Templates with a location header are not supported yet';
  else if (!body) reason = 'This template has no body text';
  else {
    const odd = buttons.find(b => !SIMPLE_BUTTONS.has(b.type));
    if (odd) reason = `Templates with a ${odd.type.toLowerCase().replace(/_/g, ' ')} button are not supported yet`;
  }

  const slots: TemplateSlot[] = [];
  if (headerFormat === 'TEXT') {
    for (const name of placeholders(header?.text)) slots.push({ key: `header:${name}`, label: `Header {{${name}}}`, hint: 'Shown in bold at the top (max 60 characters)' });
  }
  for (const name of placeholders(body?.text)) slots.push({ key: `body:${name}`, label: `{{${name}}}`, hint: 'Part of the message text' });
  buttons.forEach((button, index) => {
    if (button.type === 'URL' && button.url && placeholders(button.url).length) {
      slots.push({ key: `button:${index}:1`, label: `Link for “${button.text}”`, hint: `Replaces the end of ${button.url}` });
    }
    if (button.type === 'COPY_CODE') slots.push({ key: `button:${index}:coupon`, label: `Offer code for “${button.text || 'Copy offer code'}”`, hint: 'Up to 15 letters or digits' });
  });

  return {
    supported: reason === null,
    reason,
    headerFormat,
    headerText: headerFormat === 'TEXT' ? (header?.text ?? null) : null,
    bodyText: body?.text ?? '',
    footerText: footer?.text ?? null,
    buttons,
    slots,
  };
}

/** WhatsApp refuses template values with line breaks, tabs, runs of spaces, or nothing at all. */
function clean(value: string, max: number): string {
  const text = value.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max).trim();
  return text || '-';
}

export interface BuiltTemplate {
  components: Array<Record<string, unknown>>;
  /** What the customer sees, for the inbox and reports. */
  text: string;
}

/**
 * Build the Cloud API `components` for one recipient. `value(key)` returns the business's choice
 * for a slot, already personalized for this contact.
 */
export function buildTemplateComponents(
  shape: TemplateShape,
  value: (key: string) => string,
  headerMedia?: { kind: 'image' | 'video' | 'document'; id: string; filename?: string } | null,
): BuiltTemplate {
  const components: Array<Record<string, unknown>> = [];
  const filled = new Map<string, string>();
  const param = (slot: TemplateSlot, max: number) => {
    const name = slot.key.split(':')[1];
    const text = clean(value(slot.key), max);
    filled.set(slot.key, text);
    return /^\d+$/.test(name) ? { type: 'text', text } : { type: 'text', parameter_name: name, text };
  };

  const headerSlots = shape.slots.filter(s => s.key.startsWith('header:'));
  if (headerSlots.length) components.push({ type: 'header', parameters: headerSlots.map(s => param(s, 60)) });
  if (MEDIA_HEADERS.has(shape.headerFormat)) {
    if (!headerMedia) throw new Error('This template needs a header image, video or document');
    const media: Record<string, string> = { id: headerMedia.id };
    if (headerMedia.kind === 'document' && headerMedia.filename) media.filename = headerMedia.filename;
    components.push({ type: 'header', parameters: [{ type: headerMedia.kind, [headerMedia.kind]: media }] });
  }
  const bodySlots = shape.slots.filter(s => s.key.startsWith('body:'));
  if (bodySlots.length) components.push({ type: 'body', parameters: bodySlots.map(s => param(s, 1024)) });
  for (const slot of shape.slots.filter(s => s.key.startsWith('button:'))) {
    const [, index, kind] = slot.key.split(':');
    const raw = value(slot.key);
    if (kind === 'coupon') {
      const code = clean(raw, 15).replace(/\s+/g, '');
      filled.set(slot.key, code);
      components.push({ type: 'button', sub_type: 'copy_code', index, parameters: [{ type: 'coupon_code', coupon_code: code }] });
    } else {
      const suffix = clean(raw, 2000).replace(/\s+/g, '');
      filled.set(slot.key, suffix);
      components.push({ type: 'button', sub_type: 'url', index, parameters: [{ type: 'text', text: suffix }] });
    }
  }

  const substitute = (text: string | null, part: 'header' | 'body') =>
    (text ?? '').replace(PLACEHOLDER, (match, name: string) => filled.get(`${part}:${name}`) ?? match);
  const lines = [
    shape.headerText ? `*${substitute(shape.headerText, 'header')}*` : '',
    substitute(shape.bodyText, 'body'),
    shape.footerText ? `_${shape.footerText}_` : '',
    shape.buttons.length ? shape.buttons.map(b => `[${b.text}]`).join(' ') : '',
  ].filter(Boolean);
  return { components, text: lines.join('\n\n') };
}
