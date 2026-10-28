/**
 * Creating WhatsApp message templates inside WA Reach. A business fills in a friendly form (a
 * "draft"): blanks are written as {{first_name}} or {{offer_code}}, buttons are picked from a menu.
 * This module checks a draft against Meta's rules before it is sent for review (so it isn't
 * rejected for a fixable reason), and turns it into the Cloud API's template format.
 *
 * Templates are submitted with positional blanks ({{1}}, {{2}}), which every template type
 * accepts; the names the business gave each blank are kept as labels, so campaigns can fill them
 * in automatically (a blank called first_name becomes the customer's first name).
 */
import { z } from 'zod';
import type { MetaTemplateComponent } from './client.js';

export const TEMPLATE_LANGUAGES: Array<[code: string, name: string]> = [
  ['en', 'English'], ['en_US', 'English (US)'], ['en_GB', 'English (UK)'], ['en_IN', 'English (India)'], ['hi', 'Hindi'], ['mr', 'Marathi'],
  ['gu', 'Gujarati'], ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['bn', 'Bengali'], ['bn_IN', 'Bengali (India)'],
  ['pa', 'Punjabi'], ['ur', 'Urdu'], ['ar', 'Arabic'], ['ar_AE', 'Arabic (UAE)'], ['en_AE', 'English (UAE)'], ['af', 'Afrikaans'], ['sq', 'Albanian'],
  ['ar_EG', 'Arabic (Egypt)'], ['ar_LB', 'Arabic (Lebanon)'], ['ar_MA', 'Arabic (Morocco)'], ['ar_QA', 'Arabic (Qatar)'], ['az', 'Azerbaijani'],
  ['be_BY', 'Belarusian'], ['bg', 'Bulgarian'], ['ca', 'Catalan'], ['zh_CN', 'Chinese (China)'], ['zh_HK', 'Chinese (Hong Kong)'],
  ['zh_TW', 'Chinese (Taiwan)'], ['hr', 'Croatian'], ['cs', 'Czech'], ['da', 'Danish'], ['prs_AF', 'Dari'], ['nl', 'Dutch'], ['nl_BE', 'Dutch (Belgium)'],
  ['en_AU', 'English (Australia)'], ['en_CA', 'English (Canada)'], ['en_GH', 'English (Ghana)'], ['en_IE', 'English (Ireland)'],
  ['en_JM', 'English (Jamaica)'], ['en_MY', 'English (Malaysia)'], ['en_NZ', 'English (New Zealand)'], ['en_QA', 'English (Qatar)'],
  ['en_SG', 'English (Singapore)'], ['en_UG', 'English (Uganda)'], ['en_ZA', 'English (South Africa)'], ['et', 'Estonian'], ['fil', 'Filipino'],
  ['fi', 'Finnish'], ['fr', 'French'], ['fr_BE', 'French (Belgium)'], ['fr_CA', 'French (Canada)'], ['fr_CH', 'French (Switzerland)'],
  ['fr_CI', "French (Côte d'Ivoire)"], ['fr_MA', 'French (Morocco)'], ['ka', 'Georgian'], ['de', 'German'], ['de_AT', 'German (Austria)'],
  ['de_CH', 'German (Switzerland)'], ['el', 'Greek'], ['ha', 'Hausa'], ['he', 'Hebrew'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['ga', 'Irish'],
  ['it', 'Italian'], ['ja', 'Japanese'], ['kk', 'Kazakh'], ['rw_RW', 'Kinyarwanda'], ['ko', 'Korean'], ['ky_KG', 'Kyrgyz'], ['lo', 'Lao'],
  ['lv', 'Latvian'], ['lt', 'Lithuanian'], ['mk', 'Macedonian'], ['ms', 'Malay'], ['nb', 'Norwegian'], ['ps_AF', 'Pashto'], ['fa', 'Persian'],
  ['pl', 'Polish'], ['pt_BR', 'Portuguese (Brazil)'], ['pt_PT', 'Portuguese (Portugal)'], ['ro', 'Romanian'], ['ru', 'Russian'], ['sr', 'Serbian'],
  ['si_LK', 'Sinhala'], ['sk', 'Slovak'], ['sl', 'Slovenian'], ['es', 'Spanish'], ['es_AR', 'Spanish (Argentina)'], ['es_CL', 'Spanish (Chile)'],
  ['es_CO', 'Spanish (Colombia)'], ['es_CR', 'Spanish (Costa Rica)'], ['es_DO', 'Spanish (Dominican Republic)'], ['es_EC', 'Spanish (Ecuador)'],
  ['es_HN', 'Spanish (Honduras)'], ['es_MX', 'Spanish (Mexico)'], ['es_PA', 'Spanish (Panama)'], ['es_PE', 'Spanish (Peru)'], ['es_ES', 'Spanish (Spain)'],
  ['es_UY', 'Spanish (Uruguay)'], ['sw', 'Swahili'], ['sv', 'Swedish'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['uz', 'Uzbek'],
  ['vi', 'Vietnamese'], ['zu', 'Zulu'],
];
const LANGUAGE_CODES = new Set(TEMPLATE_LANGUAGES.map(([code]) => code));

const label = z.string().max(200).default('');
const quickReply = z.object({ type: z.literal('quick_reply'), text: label });
const urlButton = z.object({
  type: z.literal('url'),
  text: label,
  url: z.string().max(2100).default(''),
  /** static: one link for everyone; dynamic: its end differs per message; tracked: taps are counted. */
  mode: z.enum(['static', 'dynamic', 'tracked']).default('static'),
  /** Dynamic links: an example ending, e.g. an order number. */
  example: z.string().max(500).default(''),
});
const phoneButton = z.object({ type: z.literal('phone'), text: label, phone: z.string().max(40).default('') });
const copyCode = z.object({ type: z.literal('copy_code'), example: z.string().max(100).default('') });

export const buttonSchema = z.discriminatedUnion('type', [quickReply, urlButton, phoneButton, copyCode]);
const cardButtonSchema = z.discriminatedUnion('type', [quickReply, urlButton, phoneButton]);
export type DraftButton = z.infer<typeof buttonSchema>;

const mediaId = z.coerce.number().int().positive().nullable().default(null);

export const draftSchema = z.object({
  name: z.string().trim().max(600).default(''),
  language: z.string().trim().max(15).default('en'),
  category: z.enum(['MARKETING', 'UTILITY']).default('MARKETING'),
  /** standard, carousel (2-10 swipeable cards), or a limited-time offer with a countdown. */
  format: z.enum(['standard', 'carousel', 'offer']).default('standard'),
  header: z
    .object({
      type: z.enum(['none', 'text', 'image', 'video', 'document', 'location']).default('none'),
      text: z.string().max(500).default(''),
      mediaId,
    })
    .default({ type: 'none', text: '', mediaId: null }),
  body: z.string().max(5000).default(''),
  footer: z.string().max(500).default(''),
  buttons: z.array(buttonSchema).max(12).default([]),
  /** Example value for each blank, by its name (Meta needs one to review the template). */
  samples: z.record(z.string().max(60), z.string().max(500)).default({}),
  offer: z.object({ text: z.string().max(100).default(''), expires: z.boolean().default(true) }).default({ text: '', expires: true }),
  cardFormat: z.enum(['image', 'video']).default('image'),
  cards: z
    .array(z.object({ mediaId, body: z.string().max(1000).default(''), buttons: z.array(cardButtonSchema).max(3).default([]) }))
    .max(10)
    .default([]),
});
export type TemplateDraft = z.infer<typeof draftSchema>;

export interface Problem {
  level: 'error' | 'warning';
  /** Where in the form: "name", "body", "header", "buttons.1", "cards.0.body"... */
  field: string;
  message: string;
}

export interface MediaFacts {
  mimetype: string;
  size: number;
  filename: string;
}

export interface CheckContext {
  /** This server's click-tracking link prefix (".../r/"), when it has a public address. */
  trackingPrefix: string | null;
  media: (id: number) => MediaFacts | null;
}

const BLANK = /\{\{([^{}]*)\}\}/g;
const BLANK_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const EMOJI = /\p{Extended_Pictographic}/u;
const PROMOTIONAL = /\b(offer|discount|sale|% ?off|off on|free|deal|coupon|promo|cashback|buy now|shop now|limited time|hurry)\b/i;

const MEDIA_RULES: Record<'image' | 'video' | 'document', { types: string[]; max: number; label: string }> = {
  image: { types: ['image/jpeg', 'image/png'], max: 5 * 1024 * 1024, label: 'a JPG or PNG image up to 5 MB' },
  video: { types: ['video/mp4'], max: 16 * 1024 * 1024, label: 'an MP4 video up to 16 MB' },
  document: { types: ['application/pdf'], max: 100 * 1024 * 1024, label: 'a PDF up to 100 MB' },
};

/** The blanks in a text, in order (a name used twice counts twice). */
export function blanksIn(text: string): string[] {
  return [...text.matchAll(BLANK)].map(m => m[1].trim());
}

/** "offer_code" → "Offer code". */
export function blankLabel(name: string): string {
  const words = name.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Blank';
}

/** What a campaign fills a blank with by default: the customer's own details where the name says so. */
export function suggestedValue(name: string): string {
  switch (name) {
    case 'first_name':
    case 'name':
    case 'customer_name':
      return `{{${name === 'customer_name' ? 'name' : name}|there}}`;
    case 'full_name':
      return '{{name|there}}';
    case 'last_name':
    case 'phone':
    case 'email':
    case 'city':
    case 'business_name':
      return `{{${name}}}`;
    default:
      return '';
  }
}

/** "Diwali offer 2026!" → "diwali_offer_2026". */
export function templateNameFrom(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 512);
}

function normalPhone(value: string): string {
  const digits = value.replace(/[\s\-().]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/** Quick replies and other buttons must each sit together; keep the order within each group. */
function grouped<T extends { type: string }>(buttons: T[]): T[] {
  if (buttons.length === 0) return buttons;
  const quick = buttons.filter(b => b.type === 'quick_reply');
  const other = buttons.filter(b => b.type !== 'quick_reply');
  return buttons[0].type === 'quick_reply' ? [...quick, ...other] : [...other, ...quick];
}

/** Check a draft against Meta's rules. Errors block submitting; warnings are advice. */
export function checkDraft(draft: TemplateDraft, ctx: CheckContext): Problem[] {
  const problems: Problem[] = [];
  const error = (field: string, message: string) => problems.push({ level: 'error', field, message });
  const warn = (field: string, message: string) => problems.push({ level: 'warning', field, message });
  const marketing = draft.category === 'MARKETING';

  if (!draft.name) error('name', 'Give the template a name');
  else if (!/^[a-z0-9_]+$/.test(draft.name)) error('name', 'The name can only have small letters, numbers and _ (e.g. diwali_offer_2026)');
  else if (draft.name.length > 512) error('name', 'The name is too long');
  if (!LANGUAGE_CODES.has(draft.language)) error('language', 'Choose a language');
  if (draft.format !== 'standard' && !marketing) error('format', `${draft.format === 'carousel' ? 'Carousels' : 'Limited-time offers'} are only for marketing templates`);

  // Blanks: names, samples, and where they sit.
  const allBlanks = new Set<string>();
  const checkBlanks = (field: string, text: string, where: string) => {
    for (const name of blanksIn(text)) {
      if (!BLANK_NAME.test(name)) {
        error(field, `Blank {{${name}}} ${where}: use small letters, numbers and _ only, starting with a letter, e.g. {{first_name}}`);
        continue;
      }
      allBlanks.add(name);
    }
    if (/\{\{[^{}]*$|^[^{}]*\}\}/.test(text.replace(BLANK, ''))) error(field, `Check the curly brackets ${where}: each blank is written {{like_this}}`);
  };
  const checkMessageText = (field: string, text: string, max: number, where: string) => {
    if (!text.trim()) return error(field, `Write the message ${where}`);
    if (text.length > max) error(field, `The text ${where} is ${text.length} characters; WhatsApp allows ${max}`);
    checkBlanks(field, text, where);
    const blanks = blanksIn(text);
    if (blanks.length === 0) return;
    if (/^\s*\{\{/.test(text)) error(field, `The text ${where} can't start with a blank. Add a word before it, e.g. "Hi {{first_name}}"`);
    if (/\}\}\s*$/.test(text)) error(field, `The text ${where} can't end with a blank. Add a word or full stop after it`);
    if (/\}\}\s*\{\{/.test(text)) error(field, `Two blanks ${where} are next to each other. Put a word between them`);
    const words = text.replace(BLANK, ' ').split(/\s+/).filter(w => /\p{L}/u.test(w)).length;
    if (words < blanks.length * 2 + 1) warn(field, `The text ${where} is mostly blanks. Meta rejects templates with too few words for their blanks: add more text`);
  };

  // Header
  const header = draft.header;
  if (draft.format === 'carousel' && header.type !== 'none') error('header', 'Carousels have no header: each card has its own photo or video');
  if (draft.format === 'offer' && !['none', 'image', 'video'].includes(header.type)) error('header', 'Limited-time offers can have a photo or video at the top, or nothing');
  if (header.type === 'text') {
    if (!header.text.trim()) error('header', 'Write the header text, or choose no header');
    if (header.text.length > 60) error('header', `The header is ${header.text.length} characters; WhatsApp allows 60`);
    if (/[\r\n]/.test(header.text)) error('header', "The header can't have line breaks");
    if (EMOJI.test(header.text)) error('header', "The header can't have emojis. Put them in the message instead");
    if (/[*_~`]/.test(header.text.replace(BLANK, ''))) error('header', "The header can't use bold, italics or other formatting");
    checkBlanks('header', header.text, 'in the header');
    if (blanksIn(header.text).length > 1) error('header', 'The header can have only one blank');
  }
  const checkMedia = (field: string, id: number | null, kind: 'image' | 'video' | 'document', what: string) => {
    if (!id) return error(field, `Choose ${what}. Meta reviews it as an example; each campaign can use a different one`);
    const facts = ctx.media(id);
    const rule = MEDIA_RULES[kind];
    if (!facts) return error(field, `The ${kind} chosen for ${what.replace(/^an? /, '')} no longer exists. Choose another`);
    if (!rule.types.includes(facts.mimetype)) error(field, `${facts.filename} can't be used here: choose ${rule.label}`);
    else if (facts.size > rule.max) error(field, `${facts.filename} is too big: choose ${rule.label}`);
  };
  if (header.type === 'image' || header.type === 'video' || header.type === 'document') {
    checkMedia('header', header.mediaId, header.type, `${header.type === 'image' ? 'an image' : `a ${header.type}`} for the header`);
  }

  // Offer
  if (draft.format === 'offer') {
    if (!draft.offer.text.trim()) error('offer', 'Write the offer headline, e.g. "Diwali deal"');
    else if (draft.offer.text.length > 16) error('offer', `The offer headline is ${draft.offer.text.length} characters; WhatsApp allows 16`);
    if (EMOJI.test(draft.offer.text)) error('offer', "The offer headline can't have emojis");
  }

  // Body
  checkMessageText('body', draft.body, draft.format === 'offer' ? 600 : 1024, 'of the message');
  if (/\n{3,}/.test(draft.body)) warn('body', 'Too many empty lines in a row: Meta may reject it. Use at most one empty line between paragraphs');

  // Footer
  if (draft.footer) {
    if (draft.format !== 'standard') error('footer', `${draft.format === 'carousel' ? 'Carousels' : 'Limited-time offers'} can't have a footer`);
    if (draft.footer.length > 60) error('footer', `The footer is ${draft.footer.length} characters; WhatsApp allows 60`);
    if (blanksIn(draft.footer).length) error('footer', "The footer can't have blanks");
    if (/[\r\n]/.test(draft.footer)) error('footer', "The footer can't have line breaks");
  }

  // Buttons
  const checkButtons = (buttons: Array<DraftButton>, prefix: string, where: string) => {
    const texts = new Set<string>();
    buttons.forEach((button, i) => {
      const field = `${prefix}buttons.${i}`;
      if (button.type !== 'copy_code') {
        const text = button.text.trim();
        if (!text) error(field, `Write the text of button ${i + 1}${where}`);
        else if (text.length > 25) error(field, `Button “${text}” is ${text.length} characters; WhatsApp allows 25`);
        else if (texts.has(text.toLowerCase())) error(field, `Two buttons${where} say “${text}”. Each button needs its own text`);
        if (/[\r\n]/.test(button.text)) error(field, "Button text can't have line breaks");
        texts.add(text.toLowerCase());
      }
      if (button.type === 'url') {
        if (button.mode === 'tracked') {
          if (!ctx.trackingPrefix) error(field, 'Counting taps needs this server to have a public web address (PUBLIC_URL)');
        } else {
          let ok = false;
          try {
            const url = new URL(button.url);
            ok = /^https?:$/.test(url.protocol) && !/\s/.test(button.url);
          } catch {
            ok = false;
          }
          if (!ok) error(field, `Button “${button.text || i + 1}” needs a full web address starting with https://`);
          if (blanksIn(button.url).length) error(field, 'Leave out {{ }} in the link: choose "The end of the link changes" instead');
          if (button.mode === 'dynamic' && !/^[A-Za-z0-9\-._~%/?=&+#]{1,200}$/.test(button.example.trim())) {
            error(field, `Give an example ending for “${button.text || 'the link'}” (no spaces), e.g. an order number`);
          }
        }
      }
      if (button.type === 'phone' && !/^\+[1-9]\d{6,18}$/.test(normalPhone(button.phone))) {
        error(field, `Button “${button.text || i + 1}” needs a phone number with country code, e.g. +91 98450 12345`);
      }
      if (button.type === 'copy_code') {
        if (!marketing) error(field, 'Offer code buttons are only for marketing templates');
        if (!/^[A-Za-z0-9]{1,15}$/.test(button.example.trim())) error(field, 'Give an example offer code: up to 15 letters or numbers, e.g. DIWALI20');
      }
    });
    const count = (type: DraftButton['type']) => buttons.filter(b => b.type === type).length;
    if (count('url') > 2) error(`${prefix}buttons`, `Up to 2 website buttons${where}`);
    if (count('phone') > 1) error(`${prefix}buttons`, `Only one call button${where}`);
    if (count('copy_code') > 1) error(`${prefix}buttons`, 'Only one offer code button');
  };

  if (draft.format === 'standard') {
    if (draft.buttons.length > 10) error('buttons', 'Up to 10 buttons');
    checkButtons(draft.buttons, '', '');
    if (marketing && !draft.buttons.some(b => b.type === 'quick_reply' && /^stop promotions?$/i.test(b.text.trim()))) {
      warn('buttons', 'Add a “Stop promotions” button: customers who tap it are unsubscribed automatically, and Meta rates marketing templates with an opt-out better');
    }
    if (draft.buttons.length > 3) warn('buttons', 'With more than 3 buttons, WhatsApp shows 2 and puts the rest under "See all options"');
  } else if (draft.format === 'offer') {
    const types = draft.buttons.map(b => b.type).sort().join(',');
    if (types !== 'copy_code,url') error('buttons', 'A limited-time offer has an offer code button and one website button');
    checkButtons(draft.buttons, '', '');
  } else {
    if (draft.buttons.length) error('buttons', 'Carousel buttons go on the cards');
    if (draft.cards.length < 2) error('cards', 'A carousel needs at least 2 cards');
    const withBody = draft.cards.filter(c => c.body.trim()).length;
    if (withBody && withBody !== draft.cards.length) error('cards', 'Give every card a text, or none of them');
    const shape = (card: TemplateDraft['cards'][number]) => card.buttons.map(b => b.type).join(',');
    draft.cards.forEach((card, i) => {
      const where = ` on card ${i + 1}`;
      checkMedia(`cards.${i}.media`, card.mediaId, draft.cardFormat, `${draft.cardFormat === 'image' ? 'an image' : 'a video'} for card ${i + 1}`);
      if (card.body.trim()) {
        if (card.body.length > 160) error(`cards.${i}.body`, `The text${where} is ${card.body.length} characters; WhatsApp allows 160`);
        checkBlanks(`cards.${i}.body`, card.body, where);
        if (/^\s*\{\{|\}\}\s*$/.test(card.body)) error(`cards.${i}.body`, `The text${where} can't start or end with a blank`);
      }
      if (card.buttons.length > 2) error(`cards.${i}.buttons`, `Up to 2 buttons${where}`);
      if (i > 0 && shape(card) !== shape(draft.cards[0])) error(`cards.${i}.buttons`, `Card ${i + 1} must have the same kinds of buttons as card 1, in the same order`);
      checkButtons(card.buttons as DraftButton[], `cards.${i}.`, where);
    });
  }

  // Samples for every blank.
  for (const name of allBlanks) {
    const sample = (draft.samples[name] ?? '').trim();
    if (!sample) error(`samples.${name}`, `Give an example for {{${name}}} (Meta needs one to review the template)`);
    else if (/[\r\n]/.test(sample)) error(`samples.${name}`, `The example for {{${name}}} can't have line breaks`);
  }

  // Category advice.
  if (!marketing && PROMOTIONAL.test(`${draft.header.text} ${draft.body}`)) {
    warn('category', 'This reads like a promotion. Meta may approve it as Marketing instead of Utility (WA Reach lets Meta change the category rather than reject it)');
  }
  return problems;
}

export interface BuiltDraft {
  /** The body of POST /{waba}/message_templates (name and language are left out when editing). */
  payload: { name: string; language: string; category: string; allow_category_change: boolean; parameter_format: 'positional'; components: Array<Record<string, unknown>> };
  /** Slot key ("body:1", "card:0:body:2", "header:1") → the blank's name. */
  labels: Record<string, string>;
}

/**
 * The Cloud API template for a draft that passed checkDraft. `handle(mediaId)` gives the Resumable
 * Upload handle of each example image, video or document.
 */
export function buildDraft(draft: TemplateDraft, handle: (mediaId: number) => string, trackingPrefix: string | null): BuiltDraft {
  const labels: Record<string, string> = {};
  const positional = (text: string, part: string) => {
    const names: string[] = [];
    const converted = text.replace(BLANK, (_m, name: string) => {
      names.push(name.trim());
      labels[`${part}:${names.length}`] = name.trim();
      return `{{${names.length}}}`;
    });
    return { text: converted, samples: names.map(n => (draft.samples[n] ?? '').trim()) };
  };
  const buttonsOf = (buttons: Array<DraftButton>): Array<Record<string, unknown>> =>
    grouped(buttons).map(button => {
      switch (button.type) {
        case 'quick_reply':
          return { type: 'QUICK_REPLY', text: button.text.trim() };
        case 'phone':
          return { type: 'PHONE_NUMBER', text: button.text.trim(), phone_number: normalPhone(button.phone) };
        case 'copy_code':
          return { type: 'COPY_CODE', example: button.example.trim() };
        case 'url': {
          if (button.mode === 'tracked') return { type: 'URL', text: button.text.trim(), url: `${trackingPrefix}{{1}}`, example: [`${trackingPrefix}a1b2c3d`] };
          if (button.mode === 'dynamic') {
            const base = button.url.trim();
            return { type: 'URL', text: button.text.trim(), url: `${base}{{1}}`, example: [`${base}${button.example.trim()}`] };
          }
          return { type: 'URL', text: button.text.trim(), url: button.url.trim() };
        }
      }
    });

  const components: Array<Record<string, unknown>> = [];
  const header = draft.header;
  if (header.type === 'text') {
    const { text, samples } = positional(header.text.trim(), 'header');
    components.push({ type: 'HEADER', format: 'TEXT', text, ...(samples.length ? { example: { header_text: samples } } : {}) });
  } else if (header.type === 'image' || header.type === 'video' || header.type === 'document') {
    components.push({ type: 'HEADER', format: header.type.toUpperCase(), example: { header_handle: [handle(header.mediaId!)] } });
  } else if (header.type === 'location') {
    components.push({ type: 'HEADER', format: 'LOCATION' });
  }
  if (draft.format === 'offer') {
    components.push({ type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: draft.offer.text.trim(), has_expiration: draft.offer.expires } });
  }
  const body = positional(draft.body.trim(), 'body');
  components.push({ type: 'BODY', text: body.text, ...(body.samples.length ? { example: { body_text: [body.samples] } } : {}) });
  if (draft.format === 'standard' && draft.footer.trim()) components.push({ type: 'FOOTER', text: draft.footer.trim() });
  if (draft.format === 'carousel') {
    components.push({
      type: 'CAROUSEL',
      cards: draft.cards.map((card, i) => {
        const parts: Array<Record<string, unknown>> = [{ type: 'HEADER', format: draft.cardFormat.toUpperCase(), example: { header_handle: [handle(card.mediaId!)] } }];
        if (card.body.trim()) {
          const cardBody = positional(card.body.trim(), `card:${i}:body`);
          parts.push({ type: 'BODY', text: cardBody.text, ...(cardBody.samples.length ? { example: { body_text: [cardBody.samples] } } : {}) });
        }
        if (card.buttons.length) parts.push({ type: 'BUTTONS', buttons: buttonsOf(card.buttons as DraftButton[]) });
        return { components: parts };
      }),
    });
  } else if (draft.buttons.length) {
    components.push({ type: 'BUTTONS', buttons: buttonsOf(draft.buttons) });
  }
  return {
    payload: { name: draft.name, language: draft.language, category: draft.category, allow_category_change: true, parameter_format: 'positional', components },
    labels,
  };
}

/**
 * A draft from a template that exists in Meta (made in WhatsApp Manager, or before drafts were
 * kept), to edit it or copy it into another language. Example images have to be chosen again.
 */
export function draftFromTemplate(
  template: { name: string; language: string; category: string | null; components: MetaTemplateComponent[] },
  labels: Record<string, string>,
  trackingPrefix: string | null,
): TemplateDraft {
  const samples: Record<string, string> = {};
  const named = (text: string | undefined, part: string, examples: unknown): string => {
    if (!text) return '';
    const list = Array.isArray(examples) ? (Array.isArray(examples[0]) ? (examples[0] as unknown[]) : examples) : [];
    return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key: string) => {
      const name = labels[`${part}:${key}`] ?? (/^\d+$/.test(key) ? `blank_${key}` : key.toLowerCase());
      const sample = /^\d+$/.test(key) ? list[Number(key) - 1] : undefined;
      if (typeof sample === 'string' && !samples[name]) samples[name] = sample;
      return `{{${name}}}`;
    });
  };
  const exampleOf = (c: MetaTemplateComponent | undefined, key: string) => (c?.example as Record<string, unknown> | undefined)?.[key];
  const upper = (s: string | undefined) => (s ?? '').toUpperCase();
  const find = (list: MetaTemplateComponent[], type: string) => list.find(c => upper(c.type) === type);
  const buttonsFrom = (component: MetaTemplateComponent | undefined): DraftButton[] =>
    (component?.buttons ?? []).flatMap((b): DraftButton[] => {
      const type = upper(b.type);
      if (type === 'QUICK_REPLY') return [{ type: 'quick_reply', text: b.text ?? '' }];
      if (type === 'PHONE_NUMBER') return [{ type: 'phone', text: b.text ?? '', phone: b.phone_number ?? '' }];
      if (type === 'COPY_CODE') return [{ type: 'copy_code', example: String((b as { example?: unknown }).example ?? '') }];
      if (type === 'URL') {
        const url = b.url ?? '';
        if (!url.includes('{{')) return [{ type: 'url', text: b.text ?? '', url, mode: 'static', example: '' }];
        const base = url.replace(/\{\{\s*\w+\s*\}\}$/, '');
        if (trackingPrefix && base === trackingPrefix) return [{ type: 'url', text: b.text ?? '', url: '', mode: 'tracked', example: '' }];
        const example = ((b as { example?: unknown }).example as string[] | undefined)?.[0] ?? '';
        return [{ type: 'url', text: b.text ?? '', url: base, mode: 'dynamic', example: example.startsWith(base) ? example.slice(base.length) : example }];
      }
      return [];
    });

  const list = template.components;
  const header = find(list, 'HEADER');
  const headerFormat = upper(header?.format ?? 'NONE');
  const offer = find(list, 'LIMITED_TIME_OFFER');
  const carousel = find(list, 'CAROUSEL');
  const body = find(list, 'BODY');
  const draft: TemplateDraft = draftSchema.parse({
    name: template.name,
    language: template.language,
    category: upper(template.category ?? '') === 'UTILITY' ? 'UTILITY' : 'MARKETING',
    format: carousel ? 'carousel' : offer ? 'offer' : 'standard',
    header: {
      type: ({ TEXT: 'text', IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document', LOCATION: 'location' } as Record<string, string>)[headerFormat] ?? 'none',
      text: headerFormat === 'TEXT' ? named(header?.text, 'header', exampleOf(header, 'header_text')) : '',
      mediaId: null,
    },
    body: named(body?.text, 'body', exampleOf(body, 'body_text')),
    footer: find(list, 'FOOTER')?.text ?? '',
    buttons: buttonsFrom(find(list, 'BUTTONS')),
    offer: { text: offer?.limited_time_offer?.text ?? '', expires: offer?.limited_time_offer?.has_expiration ?? true },
    cardFormat: upper(find(carousel?.cards?.[0]?.components ?? [], 'HEADER')?.format) === 'VIDEO' ? 'video' : 'image',
    cards: (carousel?.cards ?? []).map((card, i) => {
      const parts = card.components ?? [];
      const cardBody = find(parts, 'BODY');
      return { mediaId: null, body: named(cardBody?.text, `card:${i}:body`, exampleOf(cardBody, 'body_text')), buttons: buttonsFrom(find(parts, 'BUTTONS')) };
    }),
  });
  draft.samples = { ...samples, ...draft.samples };
  return draft;
}
