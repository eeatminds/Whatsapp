import { describe, expect, it } from 'vitest';
import { buildDraft, checkDraft, draftFromTemplate, draftSchema, suggestedValue, templateNameFrom } from '../server/meta/template-builder.js';

const media: Record<number, { mimetype: string; size: number; filename: string }> = {
  1: { mimetype: 'image/jpeg', size: 200_000, filename: 'diwali.jpg' },
  2: { mimetype: 'image/png', size: 300_000, filename: 'mug.png' },
  3: { mimetype: 'application/pdf', size: 90_000, filename: 'menu.pdf' },
  4: { mimetype: 'image/gif', size: 9_000, filename: 'dance.gif' },
};
const ctx = { trackingPrefix: 'https://reach.example.com/t/abc/r/', media: (id: number) => media[id] ?? null };
const errors = (input: unknown) => checkDraft(draftSchema.parse(input), ctx).filter(p => p.level === 'error').map(p => `${p.field}: ${p.message}`);
const warnings = (input: unknown) => checkDraft(draftSchema.parse(input), ctx).filter(p => p.level === 'warning').map(p => p.field);

describe('template builder', () => {
  it('turns a friendly marketing template into Meta’s format, with labels for each blank', () => {
    const draft = draftSchema.parse({
      name: templateNameFrom('Diwali Offer 2026!'),
      language: 'en',
      category: 'MARKETING',
      header: { type: 'image', mediaId: 1 },
      body: 'Hi {{first_name}}, our *Diwali hampers* are here! Use code {{offer_code}} for 20% off at our {{city}} store.',
      footer: 'Chai & Co.',
      buttons: [
        { type: 'quick_reply', text: 'Stop promotions' },
        { type: 'url', text: 'Shop now', mode: 'tracked' },
        { type: 'phone', text: 'Call us', phone: '+91 98450 12345' },
        { type: 'quick_reply', text: 'Interested' },
      ],
      samples: { first_name: 'Priya', offer_code: 'DIWALI20', city: 'Pune' },
    });
    expect(draft.name).toBe('diwali_offer_2026');
    expect(checkDraft(draft, ctx).filter(p => p.level === 'error')).toEqual([]);
    const built = buildDraft(draft, id => `handle-${id}`, ctx.trackingPrefix);
    expect(built.payload).toEqual({
      name: 'diwali_offer_2026',
      language: 'en',
      category: 'MARKETING',
      allow_category_change: true,
      parameter_format: 'positional',
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['handle-1'] } },
        {
          type: 'BODY',
          text: 'Hi {{1}}, our *Diwali hampers* are here! Use code {{2}} for 20% off at our {{3}} store.',
          example: { body_text: [['Priya', 'DIWALI20', 'Pune']] },
        },
        { type: 'FOOTER', text: 'Chai & Co.' },
        {
          type: 'BUTTONS',
          // Quick replies are kept together, as Meta requires.
          buttons: [
            { type: 'QUICK_REPLY', text: 'Stop promotions' },
            { type: 'QUICK_REPLY', text: 'Interested' },
            { type: 'URL', text: 'Shop now', url: 'https://reach.example.com/t/abc/r/{{1}}', example: ['https://reach.example.com/t/abc/r/a1b2c3d'] },
            { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+919845012345' },
          ],
        },
      ],
    });
    expect(built.labels).toEqual({ 'body:1': 'first_name', 'body:2': 'offer_code', 'body:3': 'city' });
    expect(suggestedValue('first_name')).toBe('{{first_name|there}}');
    expect(suggestedValue('offer_code')).toBe('');
  });

  it('catches what Meta rejects, before submitting', () => {
    const base = { name: 'test_one', language: 'en', category: 'MARKETING', body: 'Hello there, thanks for shopping with us today.' };
    expect(errors({ ...base, name: 'Diwali Offer' })).toEqual(['name: The name can only have small letters, numbers and _ (e.g. diwali_offer_2026)']);
    expect(errors({ ...base, language: 'xx' })[0]).toMatch(/^language/);
    expect(errors({ ...base, body: '{{first_name}}, your order is ready to collect.', samples: { first_name: 'Ravi' } })[0]).toMatch(/can't start with a blank/);
    expect(errors({ ...base, body: 'Your order is ready, {{first_name}}', samples: { first_name: 'Ravi' } })[0]).toMatch(/can't end with a blank/);
    expect(errors({ ...base, body: 'Dear {{first_name}} {{last_name}}, your order is ready.', samples: { first_name: 'Ravi', last_name: 'K' } })[0]).toMatch(/next to each other/);
    expect(errors({ ...base, body: 'Hi {{First Name}}, your order is ready.' })[0]).toMatch(/small letters/);
    expect(errors({ ...base, body: 'Hi {{first_name}}, your order is ready.' })).toEqual(['samples.first_name: Give an example for {{first_name}} (Meta needs one to review the template)']);
    expect(warnings({ ...base, body: 'Hi {{a}} and {{b}} here.', samples: { a: 'x', b: 'y' } })).toContain('body');
    expect(errors({ ...base, header: { type: 'text', text: 'Big sale 🎉' } })).toEqual(["header: The header can't have emojis. Put them in the message instead"]);
    expect(errors({ ...base, header: { type: 'image', mediaId: 4 } })).toEqual(["header: dance.gif can't be used here: choose a JPG or PNG image up to 5 MB"]);
    expect(errors({ ...base, header: { type: 'document', mediaId: null } })[0]).toMatch(/Choose a document/);
    expect(errors({ ...base, footer: 'Reply {{x}}' })).toContain("footer: The footer can't have blanks");
    expect(errors({ ...base, buttons: [{ type: 'url', text: 'Shop', url: 'shop.example.com' }] })[0]).toMatch(/https:\/\//);
    expect(errors({ ...base, buttons: [{ type: 'phone', text: 'Call', phone: '98450' }] })[0]).toMatch(/country code/);
    expect(errors({ ...base, buttons: [{ type: 'quick_reply', text: 'Yes' }, { type: 'quick_reply', text: 'yes' }] })[0]).toMatch(/Two buttons/);
    expect(errors({ ...base, category: 'UTILITY', buttons: [{ type: 'copy_code', example: 'SAVE10' }] })).toEqual(['buttons.0: Offer code buttons are only for marketing templates']);
    // Advice, not errors.
    expect(warnings(base)).toContain('buttons');
    expect(warnings({ ...base, category: 'UTILITY', body: 'Get 20% off on all orders this week only.' })).toContain('category');
  });

  it('builds carousels and limited-time offers', () => {
    const carousel = draftSchema.parse({
      name: 'new_arrivals',
      language: 'en_IN',
      format: 'carousel',
      body: 'Hi {{first_name}}, our new teaware is here. Swipe to see it all!',
      samples: { first_name: 'Asha', price: '₹499' },
      cards: [1, 2].map(id => ({ mediaId: id, body: 'Only {{price}} this week', buttons: [{ type: 'url', text: 'Buy', url: 'https://shop.example/p/' + id }] })),
    });
    expect(errors(carousel)).toEqual([]);
    const built = buildDraft(carousel, id => `h${id}`, null);
    expect(built.payload.components[1]).toEqual({
      type: 'CAROUSEL',
      cards: [1, 2].map(id => ({
        components: [
          { type: 'HEADER', format: 'IMAGE', example: { header_handle: [`h${id}`] } },
          { type: 'BODY', text: 'Only {{1}} this week', example: { body_text: [['₹499']] } },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Buy', url: `https://shop.example/p/${id}` }] },
        ],
      })),
    });
    expect(built.labels).toMatchObject({ 'body:1': 'first_name', 'card:0:body:1': 'price', 'card:1:body:1': 'price' });
    expect(errors({ ...carousel, cards: [carousel.cards[0]] })).toContain('cards: A carousel needs at least 2 cards');
    expect(errors({ ...carousel, cards: [carousel.cards[0], { ...carousel.cards[1], buttons: [{ type: 'quick_reply', text: 'More' }] }] })).toContain(
      'cards.1.buttons: Card 2 must have the same kinds of buttons as card 1, in the same order',
    );
    expect(errors({ ...carousel, category: 'UTILITY' })).toContain('format: Carousels are only for marketing templates');

    const offer = draftSchema.parse({
      name: 'diwali_deal',
      language: 'en',
      format: 'offer',
      header: { type: 'image', mediaId: 2 },
      offer: { text: 'Diwali deal', expires: true },
      body: 'Hi {{first_name}}, get 25% off on all hampers today!',
      samples: { first_name: 'Ravi' },
      buttons: [
        { type: 'copy_code', example: 'DIWALI25' },
        { type: 'url', text: 'Shop now', url: 'https://shop.example/offers?code=', mode: 'dynamic', example: 'DIWALI25' },
      ],
    });
    expect(errors(offer)).toEqual([]);
    expect(buildDraft(offer, () => 'h', null).payload.components).toEqual([
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h'] } },
      { type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Diwali deal', has_expiration: true } },
      { type: 'BODY', text: 'Hi {{1}}, get 25% off on all hampers today!', example: { body_text: [['Ravi']] } },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'COPY_CODE', example: 'DIWALI25' },
          { type: 'URL', text: 'Shop now', url: 'https://shop.example/offers?code={{1}}', example: ['https://shop.example/offers?code=DIWALI25'] },
        ],
      },
    ]);
    expect(errors({ ...offer, footer: 'Hurry' })).toContain("footer: Limited-time offers can't have a footer");
    expect(errors({ ...offer, offer: { text: 'A very long offer headline', expires: true } })[0]).toMatch(/allows 16/);
  });

  it('reads a template made in WhatsApp Manager back into the form, to edit or translate it', () => {
    const draft = draftFromTemplate(
      {
        name: 'order_update',
        language: 'en_US',
        category: 'UTILITY',
        components: [
          { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}', example: { header_text: ['#1234'] } },
          { type: 'BODY', text: 'Hi {{1}}, your order ships on {{2}}.', example: { body_text: [['Ravi', 'Monday']] } },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track', url: 'https://shop.example/track/{{1}}', example: ['https://shop.example/track/AB12'] } as never] },
        ],
      },
      { 'body:1': 'first_name' },
      null,
    );
    expect(draft).toMatchObject({
      category: 'UTILITY',
      header: { type: 'text', text: 'Order {{blank_1}}' },
      body: 'Hi {{first_name}}, your order ships on {{blank_2}}.',
      buttons: [{ type: 'url', text: 'Track', url: 'https://shop.example/track/', mode: 'dynamic', example: 'AB12' }],
      samples: { blank_1: '#1234', first_name: 'Ravi', blank_2: 'Monday' },
    });
  });
});
