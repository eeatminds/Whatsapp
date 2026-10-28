import { describe, expect, it } from 'vitest';
import { buildTemplateComponents, describeTemplate } from '../server/meta/templates.js';

describe('sending carousel, limited-time offer and map templates', () => {
  it('fills every card of a carousel with its own photo, text and link', () => {
    const shape = describeTemplate(
      [
        { type: 'BODY', text: 'Hi {{1}}, new arrivals are in!' },
        {
          type: 'CAROUSEL',
          cards: [0, 1].map(() => ({
            components: [
              { type: 'HEADER', format: 'IMAGE' },
              { type: 'BODY', text: 'Only {{1}} today' },
              { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'More like this' }, { type: 'URL', text: 'Buy', url: 'https://shop.example/p/{{1}}' }] },
            ],
          })),
        },
      ],
      'MARKETING',
    );
    expect(shape.supported).toBe(true);
    expect(shape.slots.map(s => s.key)).toEqual(['body:1', 'card:0:body:1', 'card:0:button:1:1', 'card:1:body:1', 'card:1:button:1:1']);
    const values: Record<string, string> = { 'body:1': 'Asha', 'card:0:body:1': '₹499', 'card:0:button:1:1': 'mug', 'card:1:body:1': '₹899', 'card:1:button:1:1': 'teapot' };
    const built = buildTemplateComponents(shape, key => values[key], null, {
      cardMedia: [
        { kind: 'image', id: 'm1' },
        { kind: 'image', id: 'm2' },
      ],
    });
    expect(built.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Asha' }] },
      {
        type: 'carousel',
        cards: [
          {
            card_index: 0,
            components: [
              { type: 'header', parameters: [{ type: 'image', image: { id: 'm1' } }] },
              { type: 'body', parameters: [{ type: 'text', text: '₹499' }] },
              { type: 'button', sub_type: 'url', index: 1, parameters: [{ type: 'text', text: 'mug' }] },
            ],
          },
          {
            card_index: 1,
            components: [
              { type: 'header', parameters: [{ type: 'image', image: { id: 'm2' } }] },
              { type: 'body', parameters: [{ type: 'text', text: '₹899' }] },
              { type: 'button', sub_type: 'url', index: 1, parameters: [{ type: 'text', text: 'teapot' }] },
            ],
          },
        ],
      },
    ]);
    expect(built.text).toContain('Only ₹899 today');
    expect(() => buildTemplateComponents(shape, key => values[key], null, { cardMedia: [{ kind: 'image', id: 'm1' }] })).toThrow(/each of its 2 cards/);
  });

  it('sends a limited-time offer with its end time and code, and a map header', () => {
    const offer = describeTemplate(
      [
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Diwali deal', has_expiration: true } },
        { type: 'BODY', text: 'Hi {{1}}, 20% off everything!' },
        { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', text: 'Copy offer code' }, { type: 'URL', text: 'Shop', url: 'https://shop.example/{{1}}' }] },
      ],
      'MARKETING',
    );
    expect(offer.offer).toEqual({ text: 'Diwali deal', hasExpiration: true });
    const values: Record<string, string> = { 'body:1': 'Ravi', 'button:0:coupon': 'DIWALI20', 'button:1:1': 'sale' };
    const built = buildTemplateComponents(offer, key => values[key], { kind: 'image', id: 'h1' }, { offerExpiresAt: 1_800_000_000_000 });
    expect(built.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'h1' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Ravi' }] },
      { type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: 1_800_000_000_000 } }] },
      { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: 'DIWALI20' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'sale' }] },
    ]);

    const map = describeTemplate([{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'Your order is on its way to the address above.' }], 'UTILITY');
    expect(map.supported).toBe(true);
    const sent = buildTemplateComponents(map, () => '', null, { location: { latitude: 18.52, longitude: 73.85, name: 'Chai & Co.', address: 'FC Road, Pune' } });
    expect(sent.components).toEqual([
      { type: 'header', parameters: [{ type: 'location', location: { latitude: '18.52', longitude: '73.85', name: 'Chai & Co.', address: 'FC Road, Pune' } }] },
    ]);
    expect(() => buildTemplateComponents(map, () => '', null, {})).toThrow(/location/);
  });
});
