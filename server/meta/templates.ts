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
  /**
   * A link button whose Meta URL points at this server's redirect (".../r/{{1}}"): the business
   * enters the real destination and each tap is counted like a tracked link in the message text.
   */
  tracked?: boolean;
  /** The name the business gave this blank when making the template in WA Reach. */
  name?: string;
  /** What a campaign fills it with by default, e.g. "{{first_name|there}}". */
  suggested?: string;
}

export interface TemplateButton {
  type: string;
  text: string;
  url?: string;
  phone?: string;
}

/** One card of a carousel template. */
export interface TemplateCard {
  headerFormat: string;
  bodyText: string | null;
  buttons: TemplateButton[];
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
  /** Limited-time offer templates: the offer line and whether a countdown shows. */
  offer: { text: string; hasExpiration: boolean } | null;
  /** Carousel templates: the cards, each needing its own photo or video. */
  cards: TemplateCard[];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const MEDIA_HEADERS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);
const SIMPLE_BUTTONS = new Set(['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE', 'VOICE_CALL']);
const KNOWN_COMPONENTS = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS', 'CAROUSEL', 'LIMITED_TIME_OFFER']);

/** Placeholder names in order; positional ones sorted by number, as the API expects them. */
function placeholders(text: string | null | undefined): string[] {
  if (!text) return [];
  const names = [...new Set([...text.matchAll(PLACEHOLDER)].map(m => m[1]))];
  return names.every(n => /^\d+$/.test(n)) ? names.sort((a, b) => Number(a) - Number(b)) : names;
}

const upper = (value: string | undefined) => (value ?? '').toUpperCase();

function buttonsOf(component: MetaTemplateComponent | undefined): TemplateButton[] {
  return (component?.buttons ?? []).map(b => ({ type: upper(b.type), text: b.text ?? '', url: b.url, phone: b.phone_number }));
}

/** Slots of a set of buttons: the end of a dynamic link, an offer code. `prefix` is "" or "card:N:". */
function buttonSlots(buttons: TemplateButton[], prefix: string, slots: TemplateSlot[], where = ''): void {
  buttons.forEach((button, index) => {
    if (button.type === 'URL' && button.url && placeholders(button.url).length) {
      slots.push({ key: `${prefix}button:${index}:1`, label: `Link for “${button.text}”${where}`, hint: `Replaces the end of ${button.url}` });
    }
    if (button.type === 'COPY_CODE') {
      slots.push({ key: `${prefix}button:${index}:coupon`, label: `Offer code for “${button.text || 'Copy offer code'}”${where}`, hint: 'Up to 15 letters or digits' });
    }
  });
}

export function describeTemplate(components: MetaTemplateComponent[] | undefined, category?: string | null): TemplateShape {
  const list = components ?? [];
  const find = (type: string) => list.find(c => upper(c.type) === type);
  const header = find('HEADER');
  const body = find('BODY');
  const footer = find('FOOTER');
  const offerComponent = find('LIMITED_TIME_OFFER');
  const carousel = find('CAROUSEL');
  const headerFormat = header ? upper(header.format ?? 'TEXT') : 'NONE';
  const buttons = buttonsOf(find('BUTTONS'));
  const cards: TemplateCard[] = (carousel?.cards ?? []).map(card => {
    const parts = card.components ?? [];
    const part = (type: string) => parts.find(c => upper(c.type) === type);
    return { headerFormat: upper(part('HEADER')?.format ?? 'IMAGE'), bodyText: part('BODY')?.text ?? null, buttons: buttonsOf(part('BUTTONS')) };
  });

  let reason: string | null = null;
  const unknown = list.find(c => !KNOWN_COMPONENTS.has(upper(c.type)));
  const allButtons = [...buttons, ...cards.flatMap(c => c.buttons)];
  if (upper(category ?? '') === 'AUTHENTICATION') reason = 'Authentication (one-time code) templates are not for marketing';
  else if (unknown) reason = `${unknown.type.toLowerCase().replace(/_/g, ' ')} templates are not supported yet`;
  else if (!body) reason = 'This template has no body text';
  else if (carousel && cards.length === 0) reason = 'This carousel template has no cards';
  else if (cards.some(c => !['IMAGE', 'VIDEO'].includes(c.headerFormat))) reason = 'Carousel cards need a photo or video';
  else {
    const odd = allButtons.find(b => !SIMPLE_BUTTONS.has(b.type));
    if (odd) reason = `Templates with a ${odd.type.toLowerCase().replace(/_/g, ' ')} button are not supported yet`;
  }

  const slots: TemplateSlot[] = [];
  if (headerFormat === 'TEXT') {
    for (const name of placeholders(header?.text)) slots.push({ key: `header:${name}`, label: `Header {{${name}}}`, hint: 'Shown in bold at the top (max 60 characters)' });
  }
  for (const name of placeholders(body?.text)) slots.push({ key: `body:${name}`, label: `{{${name}}}`, hint: 'Part of the message text' });
  buttonSlots(buttons, '', slots);
  cards.forEach((card, i) => {
    for (const name of placeholders(card.bodyText)) {
      slots.push({ key: `card:${i}:body:${name}`, label: `Card ${i + 1} {{${name}}}`, hint: `Part of card ${i + 1}'s text` });
    }
    buttonSlots(card.buttons, `card:${i}:`, slots, ` (card ${i + 1})`);
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
    offer: offerComponent ? { text: offerComponent.limited_time_offer?.text ?? '', hasExpiration: !!offerComponent.limited_time_offer?.has_expiration } : null,
    cards,
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

type HeaderMedia = { kind: 'image' | 'video' | 'document'; id: string; filename?: string };

/** What a template needs besides its text blanks, chosen per campaign. */
export interface TemplateExtras {
  /** Map pin for a location header. */
  location?: { latitude: number; longitude: number; name?: string | null; address?: string | null } | null;
  /** When a limited-time offer ends (epoch milliseconds). */
  offerExpiresAt?: number | null;
  /** A photo or video per carousel card, in card order. */
  cardMedia?: Array<{ kind: 'image' | 'video'; id: string }>;
}

/**
 * Build the Cloud API `components` for one recipient. `value(key)` returns the business's choice
 * for a slot, already personalized for this contact.
 */
export function buildTemplateComponents(shape: TemplateShape, value: (key: string) => string, headerMedia?: HeaderMedia | null, extras: TemplateExtras = {}): BuiltTemplate {
  const components: Array<Record<string, unknown>> = [];
  const filled = new Map<string, string>();
  const param = (slot: TemplateSlot, max: number) => {
    const name = slot.key.split(':').at(-1)!;
    const text = clean(value(slot.key), max);
    filled.set(slot.key, text);
    return /^\d+$/.test(name) ? { type: 'text', text } : { type: 'text', parameter_name: name, text };
  };
  const buttonParams = (slots: TemplateSlot[], prefix: string) => {
    const out: Array<Record<string, unknown>> = [];
    for (const slot of slots) {
      const [index, kind] = slot.key.slice(prefix.length).split(':').slice(1);
      const raw = value(slot.key);
      if (kind === 'coupon') {
        const code = clean(raw, 15).replace(/\s+/g, '');
        filled.set(slot.key, code);
        out.push({ type: 'button', sub_type: 'copy_code', index: prefix ? Number(index) : index, parameters: [{ type: 'coupon_code', coupon_code: code }] });
      } else {
        const suffix = clean(raw, 2000).replace(/\s+/g, '');
        filled.set(slot.key, suffix);
        out.push({ type: 'button', sub_type: 'url', index: prefix ? Number(index) : index, parameters: [{ type: 'text', text: suffix }] });
      }
    }
    return out;
  };
  const top = shape.slots.filter(s => !s.key.startsWith('card:'));

  const headerSlots = top.filter(s => s.key.startsWith('header:'));
  if (headerSlots.length) components.push({ type: 'header', parameters: headerSlots.map(s => param(s, 60)) });
  if (MEDIA_HEADERS.has(shape.headerFormat)) {
    if (!headerMedia) throw new Error('This template needs a header image, video or document');
    const media: Record<string, string> = { id: headerMedia.id };
    if (headerMedia.kind === 'document' && headerMedia.filename) media.filename = headerMedia.filename;
    components.push({ type: 'header', parameters: [{ type: headerMedia.kind, [headerMedia.kind]: media }] });
  }
  if (shape.headerFormat === 'LOCATION') {
    const place = extras.location;
    if (!place) throw new Error('This template needs a location for its map');
    const location: Record<string, string> = { latitude: String(place.latitude), longitude: String(place.longitude) };
    if (place.name) location.name = clean(place.name, 100);
    if (place.address) location.address = clean(place.address, 200);
    components.push({ type: 'header', parameters: [{ type: 'location', location }] });
  }
  const bodySlots = top.filter(s => s.key.startsWith('body:'));
  if (bodySlots.length) components.push({ type: 'body', parameters: bodySlots.map(s => param(s, 1024)) });
  if (shape.offer?.hasExpiration) {
    if (!extras.offerExpiresAt) throw new Error('This offer template needs an end date and time');
    components.push({ type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: extras.offerExpiresAt } }] });
  }
  if (shape.cards.length) {
    const media = extras.cardMedia ?? [];
    if (media.length < shape.cards.length) throw new Error(`This carousel needs a photo or video for each of its ${shape.cards.length} cards`);
    components.push({
      type: 'carousel',
      cards: shape.cards.map((_card, i) => {
        const prefix = `card:${i}:`;
        const cardSlots = shape.slots.filter(s => s.key.startsWith(prefix));
        const parts: Array<Record<string, unknown>> = [{ type: 'header', parameters: [{ type: media[i].kind, [media[i].kind]: { id: media[i].id } }] }];
        const cardBody = cardSlots.filter(s => s.key.startsWith(`${prefix}body:`));
        if (cardBody.length) parts.push({ type: 'body', parameters: cardBody.map(s => param(s, 160)) });
        parts.push(...buttonParams(cardSlots.filter(s => s.key.startsWith(`${prefix}button:`)), prefix));
        return { card_index: i, components: parts };
      }),
    });
  }
  components.push(...buttonParams(top.filter(s => s.key.startsWith('button:')), ''));

  const substitute = (text: string | null, part: string) => (text ?? '').replace(PLACEHOLDER, (match, name: string) => filled.get(`${part}:${name}`) ?? match);
  const lines = [
    shape.headerText ? `*${substitute(shape.headerText, 'header')}*` : '',
    shape.offer ? `🏷️ ${shape.offer.text}` : '',
    substitute(shape.bodyText, 'body'),
    ...shape.cards.map((card, i) => `🖼️ ${card.bodyText ? substitute(card.bodyText, `card:${i}:body`) : `Card ${i + 1}`}`),
    shape.footerText ? `_${shape.footerText}_` : '',
    shape.buttons.length ? shape.buttons.map(b => `[${b.text || 'Copy offer code'}]`).join(' ') : '',
  ].filter(Boolean);
  return { components, text: lines.join('\n\n') };
}
