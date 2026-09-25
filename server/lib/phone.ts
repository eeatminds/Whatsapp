import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export type PhoneResult = { ok: true; phone: string; country?: string } | { ok: false; reason: string };

/**
 * Normalize user-entered phone numbers to E.164 digits without the '+', the form WhatsApp chat ids
 * use ("919876543210" -> "919876543210@c.us").
 *
 * Accepts the shapes spreadsheets actually contain: "+91 98765 43210", "0091-98765-43210",
 * "098765 43210" (national, resolved with the default country), and "919876543210" (international
 * without the '+', which is how many CRMs export numbers).
 */
export function normalizePhone(input: unknown, defaultCountry: string = 'IN'): PhoneResult {
  if (input === null || input === undefined) return { ok: false, reason: 'empty' };
  let raw = String(input).trim();
  if (!raw) return { ok: false, reason: 'empty' };

  // Spreadsheet exports sometimes turn long numbers into scientific notation.
  if (/^\d(\.\d+)?e\+\d+$/i.test(raw)) {
    return { ok: false, reason: 'number was converted to scientific notation by a spreadsheet' };
  }

  // Strip a WhatsApp jid suffix if someone pasted a chat id.
  raw = raw.replace(/@(c\.us|s\.whatsapp\.net)$/i, '');
  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'no digits' };
  if (!hasPlus && digits.startsWith('00')) {
    digits = digits.slice(2);
    return fromInternational(digits);
  }
  if (hasPlus) return fromInternational(digits);

  const country = (defaultCountry || 'IN').toUpperCase() as CountryCode;
  const national = parsePhoneNumberFromString(digits, country);
  if (national?.isValid()) {
    return { ok: true, phone: national.number.slice(1), country: national.country };
  }
  const international = fromInternational(digits);
  if (international.ok) return international;
  return { ok: false, reason: `not a valid phone number for ${country} or in international format` };
}

function fromInternational(digits: string): PhoneResult {
  const parsed = parsePhoneNumberFromString(`+${digits}`);
  if (parsed?.isValid()) return { ok: true, phone: parsed.number.slice(1), country: parsed.country };
  return { ok: false, reason: 'not a valid international number' };
}

export function chatIdFor(phone: string): string {
  return `${phone}@c.us`;
}

/** Extract the phone digits from a WhatsApp id, or null for ids that are not phone-based (@lid, groups). */
export function phoneFromChatId(chatId: string | null | undefined): string | null {
  if (!chatId) return null;
  const match = /^(\d{6,20})(?::\d+)?@(c\.us|s\.whatsapp\.net)$/.exec(chatId);
  return match ? match[1] : null;
}

export function formatPhone(phone: string): string {
  const parsed = parsePhoneNumberFromString(`+${phone}`);
  return parsed ? parsed.formatInternational() : `+${phone}`;
}
