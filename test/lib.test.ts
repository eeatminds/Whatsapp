import { describe, expect, it } from 'vitest';
import { normalizePhone, phoneFromChatId } from '../server/lib/phone.js';
import { renderTemplate, templateVariables, contactVariables } from '../server/lib/template.js';
import { parseCsv, toCsv, detectDelimiter } from '../server/lib/csv.js';
import { isQuietTime, startOfLocalDay, localDateKey, minutesUntilQuietEnds } from '../server/lib/time.js';
import { extractUrls, replaceUrls, isBotUserAgent } from '../server/lib/links.js';
import { signSession, verifySession, verifyOpenWASignature, signOpenWABody, randomToken } from '../server/lib/crypto.js';
import { matchesRule, normalizeKeywordText } from '../server/services/auto-replies.js';
import { compileRules, rulesSchema } from '../server/services/segments.js';
import { normalizeAckStatus } from '../server/services/messages.js';

describe('normalizePhone', () => {
  it.each([
    ['+91 98765 43210', '919876543210'],
    ['098765 43210', '919876543210'],
    ['9876543210', '919876543210'],
    ['919876543210', '919876543210'],
    ['0091-98765-43210', '919876543210'],
    ['+1 (415) 555-2671', '14155552671'],
    ['919876543210@c.us', '919876543210'],
  ])('%s -> %s', (input, expected) => {
    const result = normalizePhone(input, 'IN');
    expect(result).toMatchObject({ ok: true, phone: expected });
  });

  it('uses the default country for national numbers', () => {
    expect(normalizePhone('07911 123456', 'GB')).toMatchObject({ ok: true, phone: '447911123456' });
  });

  it('rejects junk and spreadsheet-mangled values', () => {
    expect(normalizePhone('', 'IN').ok).toBe(false);
    expect(normalizePhone('hello', 'IN').ok).toBe(false);
    expect(normalizePhone('12345', 'IN').ok).toBe(false);
    expect(normalizePhone('9.19876E+11', 'IN')).toMatchObject({ ok: false, reason: expect.stringContaining('scientific') });
  });

  it('extracts phones from chat ids only for phone-based ids', () => {
    expect(phoneFromChatId('919876543210@c.us')).toBe('919876543210');
    expect(phoneFromChatId('919876543210@s.whatsapp.net')).toBe('919876543210');
    expect(phoneFromChatId('123456789012345@lid')).toBeNull();
    expect(phoneFromChatId('120363000000000000@g.us')).toBeNull();
  });
});

describe('renderTemplate', () => {
  const vars = contactVariables(
    { name: 'Priya Sharma', phone: '919876543210', email: null, attributes: { city: 'Pune', order_total: '1,499' } },
    { business_name: 'Chai Co' },
  );

  it('substitutes built-ins, attributes and fallbacks', () => {
    const result = renderTemplate('Hi {{first_name}} from {{ City }}! {{business_name}} · {{coupon|WELCOME10}} · ₹{{order total}}', vars);
    expect(result.text).toBe('Hi Priya from Pune! Chai Co · WELCOME10 · ₹1,499');
    expect(result.missing).toEqual([]);
  });

  it('reports missing variables and uses fallback for blanks', () => {
    const result = renderTemplate('{{nickname}} / {{email|no email}}', vars);
    expect(result.text).toBe(' / no email');
    expect(result.missing).toEqual(['nickname']);
  });

  it('lists variables', () => {
    expect(templateVariables('{{first_name|there}} {{attr.city}} {{first_name}}')).toEqual(['first_name', 'city']);
  });

  it('does not let attributes shadow built-ins', () => {
    const v = contactVariables({ name: 'A B', phone: '1', email: null, attributes: { first_name: 'Hacked' } });
    expect(renderTemplate('{{first_name}}', v).text).toBe('A');
  });
});

describe('CSV', () => {
  it('parses quotes, escaped quotes, embedded newlines, BOM and CRLF', () => {
    const text = '﻿phone,name,note\r\n"+91 98765 43210","Sharma, Priya","said ""hi""\nthen left"\r\n9876500000,Ravi,\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['phone', 'name', 'note'],
      ['+91 98765 43210', 'Sharma, Priya', 'said "hi"\nthen left'],
      ['9876500000', 'Ravi', ''],
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(detectDelimiter('phone;name\n1;2')).toBe(';');
    expect(detectDelimiter('phone\tname\n1\t2')).toBe('\t');
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('escapes output and neutralizes formulas', () => {
    expect(toCsv(['a', 'b'], [['=SUM(A1)', 'x,y']])).toBe('a,b\r\n\'=SUM(A1),"x,y"\r\n');
  });
});

describe('time zones and quiet hours', () => {
  const tz = 'Asia/Kolkata';

  it('handles windows that wrap midnight', () => {
    // 16:00 UTC = 21:30 IST -> quiet; 06:00 UTC = 11:30 IST -> not quiet; 03:00 UTC = 08:30 IST -> quiet.
    expect(isQuietTime(new Date('2026-09-25T16:00:00Z'), tz, '21:00', '09:00')).toBe(true);
    expect(isQuietTime(new Date('2026-09-25T06:00:00Z'), tz, '21:00', '09:00')).toBe(false);
    expect(isQuietTime(new Date('2026-09-25T03:00:00Z'), tz, '21:00', '09:00')).toBe(true);
    expect(minutesUntilQuietEnds(new Date('2026-09-25T03:00:00Z'), tz, '21:00', '09:00')).toBe(30);
  });

  it('handles same-day windows and empty windows', () => {
    expect(isQuietTime(new Date('2026-09-25T08:00:00Z'), tz, '13:00', '14:00')).toBe(true); // 13:30 IST
    expect(isQuietTime(new Date('2026-09-25T08:00:00Z'), tz, '10:00', '10:00')).toBe(false);
  });

  it('computes local day boundaries', () => {
    expect(startOfLocalDay(new Date('2026-09-25T06:00:00Z'), tz).toISOString()).toBe('2026-09-24T18:30:00.000Z');
    expect(localDateKey(new Date('2026-09-24T19:00:00Z'), tz)).toBe('2026-09-25');
    // DST day in New York (2026-03-08): midnight is still 05:00 UTC.
    expect(startOfLocalDay(new Date('2026-03-08T15:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });
});

describe('links', () => {
  it('extracts URLs without trailing punctuation', () => {
    expect(extractUrls('Shop now: https://shop.example.com/sale?utm=wa. Or (https://example.com/a) — https://x.io/b!')).toEqual([
      'https://shop.example.com/sale?utm=wa',
      'https://example.com/a',
      'https://x.io/b',
    ]);
    expect(extractUrls('Wiki https://en.wikipedia.org/wiki/Foo_(bar) ok')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  it('replaces URLs and keeps surrounding text', () => {
    expect(replaceUrls('Go to https://a.example.com/x.', () => 'https://t.co/1')).toBe('Go to https://t.co/1.');
  });

  it('flags link-preview bots', () => {
    expect(isBotUserAgent('WhatsApp/2.23.20.0 A')).toBe(true);
    expect(isBotUserAgent('facebookexternalhit/1.1')).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36')).toBe(false);
  });
});

describe('crypto', () => {
  it('signs and verifies sessions, rejecting tampering and expiry', () => {
    const token = signSession({ sub: 'admin', exp: Date.now() + 1000 }, 'secret');
    expect(verifySession(token, 'secret')).toMatchObject({ sub: 'admin' });
    expect(verifySession(token, 'other')).toBeNull();
    expect(verifySession(token.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), 'secret')).toBeNull();
    expect(verifySession(signSession({ exp: Date.now() - 1 }, 'secret'), 'secret')).toBeNull();
  });

  it('verifies OpenWA webhook signatures over the raw body', () => {
    const body = Buffer.from('{"event":"message.ack"}');
    const header = signOpenWABody(body, 'whsec');
    expect(header).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(verifyOpenWASignature(body, header, 'whsec')).toBe(true);
    expect(verifyOpenWASignature(Buffer.from('{"event":"x"}'), header, 'whsec')).toBe(false);
    expect(verifyOpenWASignature(body, undefined, 'whsec')).toBe(false);
    expect(verifyOpenWASignature(body, 'sha256=short', 'whsec')).toBe(false);
  });

  it('generates tokens from the unambiguous alphabet', () => {
    const token = randomToken(32);
    expect(token).toHaveLength(32);
    expect(token).not.toMatch(/[0O1lI]/);
  });
});

describe('keyword matching', () => {
  it('normalizes punctuation and case', () => {
    expect(normalizeKeywordText('  Stop!! ')).toBe('STOP');
    expect(normalizeKeywordText('opt-out')).toBe('OPT OUT');
  });

  it('matches by type', () => {
    expect(matchesRule({ matchType: 'exact', keywords: ['price'] }, 'Price?')).toBe(true);
    expect(matchesRule({ matchType: 'exact', keywords: ['price'] }, 'what price')).toBe(false);
    expect(matchesRule({ matchType: 'contains', keywords: ['price list'] }, 'Can I get the price list please')).toBe(true);
    expect(matchesRule({ matchType: 'contains', keywords: ['price'] }, 'priceless')).toBe(false);
    expect(matchesRule({ matchType: 'starts_with', keywords: ['order'] }, 'order 1234')).toBe(true);
    expect(matchesRule({ matchType: 'regex', keywords: ['^#\\d{4}$'] }, '#1234')).toBe(true);
    expect(matchesRule({ matchType: 'any', keywords: [] }, 'anything')).toBe(true);
  });
});

describe('segment rules', () => {
  it('compiles to parameterized SQL', () => {
    const rules = rulesSchema.parse({
      match: 'all',
      conditions: [
        { field: 'tag', op: 'has', value: 3 },
        { field: 'attribute', key: 'city', op: 'equals', value: 'Pune' },
        { field: 'last_inbound_at', op: 'within_days', value: 30 },
      ],
    });
    const fragment = compileRules(rules, new Date('2026-09-25T00:00:00Z'));
    expect(fragment.sql).not.toContain('Pune');
    expect(fragment.params).toEqual([3, '$.city', 'Pune', '2026-08-26T00:00:00.000Z']);
  });

  it('rejects attribute keys that could escape the JSON path', () => {
    expect(() => rulesSchema.parse({ conditions: [{ field: 'attribute', key: "x') OR 1=1 --", op: 'equals', value: 'a' }] })).toThrow();
  });
});

describe('acks', () => {
  it('maps OpenWA statuses', () => {
    expect(normalizeAckStatus('delivered')).toBe('delivered');
    expect(normalizeAckStatus('played')).toBe('read');
    expect(normalizeAckStatus('failed')).toBe('failed');
    expect(normalizeAckStatus('sent')).toBeNull();
  });
});
