import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';
import { signOpenWABody } from '../server/lib/crypto.js';

const PHONE_ID = '1098765432101';
const WABA = '2098765432101';
const TOKEN = 'EAAG' + 'x'.repeat(60);
const SECRET = 'abcdef0123456789abcdef0123456789';
const NUMBER = `official-${PHONE_ID}`;
const JPEG = Buffer.from('ffd8ffe000104a46494600', 'hex').toString('base64');

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv();
  env.meta.addNumber({ id: PHONE_ID, wabaId: WABA, token: TOKEN });
  const res = await env.api('POST', '/api/official/numbers', { name: 'Main line', phoneNumberId: PHONE_ID, wabaId: WABA, accessToken: TOKEN, appSecret: SECRET });
  expect(res.status).toBe(201);
});
afterEach(async () => {
  await env.close();
});

async function templateWebhook(value: Record<string, unknown>) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'message_template_status_update', value }] }] });
  const response = await env.app.inject({
    method: 'POST',
    url: `/webhooks/meta/${env.tenantId}`,
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signOpenWABody(raw, SECRET) },
  });
  expect(response.statusCode).toBe(200);
}

const offerDraft = (imageId: number) => ({
  name: 'diwali_hampers',
  language: 'en',
  category: 'MARKETING',
  header: { type: 'image', mediaId: imageId },
  body: 'Hi {{first_name}}, our Diwali hampers are here! Use code {{offer_code}} for 20% off.',
  footer: 'Chai & Co.',
  buttons: [
    { type: 'url', text: 'Shop now', mode: 'tracked' },
    { type: 'quick_reply', text: 'Stop promotions' },
  ],
  samples: { first_name: 'Priya', offer_code: 'DIWALI20' },
});

describe('making Meta templates inside WA Reach', () => {
  it('saves a draft, submits it with its example image, and follows the review to approved', async () => {
    const image = (await env.api('POST', '/api/media', { filename: 'hamper.jpg', mimetype: 'image/jpeg', base64: JPEG })).body;
    const options = await env.api('GET', '/api/official/template-options');
    expect(options.body.languages).toContainEqual({ code: 'hi', name: 'Hindi' });

    // Checks as the business types.
    const check = await env.api('POST', `/api/official/numbers/${NUMBER}/templates/check`, { draft: { ...offerDraft(image.id), body: 'Hi {{first_name}}' } });
    expect(check.body.problems.map((p: any) => p.message)).toContain("The text of the message can't end with a blank. Add a word or full stop after it");

    // A draft stays in WA Reach.
    const draft = await env.api('POST', `/api/official/numbers/${NUMBER}/templates`, { draft: offerDraft(image.id) });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ name: 'diwali_hampers', status: 'DRAFT', madeHere: true, canEdit: true });
    expect(env.meta.created).toEqual([]);

    // Submitting uploads the example image and sends Meta the template.
    const submitted = await env.api('PUT', `/api/official/numbers/${NUMBER}/templates/${draft.body.id}`, { draft: offerDraft(image.id), submit: true });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'PENDING', category: 'MARKETING' });
    expect(env.meta.samples).toEqual([{ appId: '777000111', filename: 'hamper.jpg', mimetype: 'image/jpeg', size: 11 }]);
    const sent = env.meta.created[0].template;
    expect(sent).toMatchObject({ name: 'diwali_hampers', language: 'en', category: 'MARKETING', allow_category_change: true });
    expect(sent.components[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::sample-1'] } });
    expect(sent.components[3].buttons[0].url).toBe('https://reach.example.com/t/' + env.tenantId + '/r/{{1}}');
    // Meta is reviewing it: no changes until it's done.
    const busy = await env.api('PUT', `/api/official/numbers/${NUMBER}/templates/${draft.body.id}`, { draft: offerDraft(image.id), submit: true });
    expect(busy.status).toBe(409);

    // Meta's webhook says approved (its language says en-US style; here plain "en").
    await templateWebhook({ event: 'APPROVED', message_template_id: Number(env.meta.created.length && (env.meta.templatesByWaba.get(WABA)![0].id)), message_template_name: 'diwali_hampers', message_template_language: 'en', reason: 'NONE' });
    const list = await env.api('GET', `/api/official/numbers/${NUMBER}/templates`);
    const approved = list.body.items.find((t: any) => t.name === 'diwali_hampers');
    expect(approved.status).toBe('APPROVED');
    // Campaigns get readable blanks with sensible defaults.
    expect(approved.slots.map((s: any) => [s.key, s.label, s.suggested ?? null, !!s.tracked])).toEqual([
      ['body:1', 'First name', '{{first_name|there}}', false],
      ['body:2', 'Offer code', '', false],
      ['button:0:1', 'Link for “Shop now”', null, true],
    ]);

    // Edit and resubmit: back to review; the name and language stay.
    const edited = await env.api('PUT', `/api/official/numbers/${NUMBER}/templates/${approved.id}`, {
      draft: { ...offerDraft(image.id), name: 'renamed', body: 'Hi {{first_name}}, Diwali hampers are back! Use {{offer_code}} for 25% off.' },
      submit: true,
    });
    expect(edited.body).toMatchObject({ name: 'diwali_hampers', status: 'PENDING' });
    expect(env.meta.edits[0].changes).not.toHaveProperty('category');
    expect(env.meta.edits[0].changes.components[1].text).toBe('Hi {{1}}, Diwali hampers are back! Use {{2}} for 25% off.');
  });

  it('shows why Meta rejected a template, from the webhook or a later check', async () => {
    const image = (await env.api('POST', '/api/media', { filename: 'hamper.jpg', mimetype: 'image/jpeg', base64: JPEG })).body;
    const created = await env.api('POST', `/api/official/numbers/${NUMBER}/templates`, { draft: { ...offerDraft(image.id), language: 'en_US' }, submit: true });
    expect(created.status).toBe(201);
    await templateWebhook({
      event: 'REJECTED',
      message_template_name: 'diwali_hampers',
      message_template_language: 'en-US',
      reason: 'INVALID_FORMAT',
      rejection_info: { reason: 'Your template has parameters placed next to each other.', recommendation: 'Separate parameters with text.' },
    });
    let template = (await env.api('GET', `/api/official/numbers/${NUMBER}/templates/${created.body.id}`)).body;
    expect(template.template).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'INVALID_FORMAT',
      statusNote: 'Your template has parameters placed next to each other. Separate parameters with text.',
      canEdit: true,
    });
    // The form comes back as it was made, to fix and resubmit.
    expect(template.draft).toMatchObject({ body: offerDraft(image.id).body, header: { type: 'image', mediaId: image.id } });

    // Without webhooks, the regular check picks up review results.
    env.meta.review(WABA, 'diwali_hampers', 'REJECTED', 'PROMOTIONAL');
    await env.s.official.syncTemplates(NUMBER);
    template = (await env.api('GET', `/api/official/numbers/${NUMBER}/templates/${created.body.id}`)).body;
    expect(template.template.rejectedReason).toBe('PROMOTIONAL');
  });

  it("refuses what Meta would refuse, and passes on Meta's own reason", async () => {
    const image = (await env.api('POST', '/api/media', { filename: 'hamper.jpg', mimetype: 'image/jpeg', base64: JPEG })).body;
    const bad = await env.api('POST', `/api/official/numbers/${NUMBER}/templates`, { draft: { ...offerDraft(image.id), body: '{{first_name}} hello' }, submit: true });
    expect(bad.status).toBe(400);
    expect(bad.body.details.problems.length).toBeGreaterThan(0);
    expect(env.meta.created).toEqual([]);

    env.meta.rejectNextTemplate = 'Template name already being deleted: try again in 4 weeks';
    const refused = await env.api('POST', `/api/official/numbers/${NUMBER}/templates`, { draft: offerDraft(image.id), submit: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('Template name already being deleted: try again in 4 weeks (Meta error 100)');

    // Same name and language twice.
    await env.api('POST', `/api/official/numbers/${NUMBER}/templates`, { draft: offerDraft(image.id) });
    const twice = await env.api('POST', `/api/official/numbers/${NUMBER}/templates`, { draft: offerDraft(image.id) });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toMatch(/already have a template called diwali_hampers/);
  });

  it('deletes drafts here and templates in Meta, and copies a template into another language', async () => {
    env.meta.templatesByWaba.set(WABA, [
      {
        id: '555001',
        name: 'order_update',
        language: 'en',
        status: 'APPROVED',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} is on its way.', example: { body_text: [['Ravi', '#1234']] } } as never],
      },
    ]);
    await env.s.official.syncTemplates(NUMBER);
    const list = (await env.api('GET', `/api/official/numbers/${NUMBER}/templates`)).body.items;
    const original = list[0];
    // Made in WhatsApp Manager: the form is rebuilt from Meta's copy.
    const { draft } = (await env.api('GET', `/api/official/numbers/${NUMBER}/templates/${original.id}`)).body;
    expect(draft).toMatchObject({ category: 'UTILITY', body: 'Hi {{blank_1}}, your order {{blank_2}} is on its way.', samples: { blank_1: 'Ravi', blank_2: '#1234' } });

    // A Hindi copy as a new template.
    const copy = await env.api('POST', `/api/official/numbers/${NUMBER}/templates`, {
      draft: { ...draft, language: 'hi', body: 'नमस्ते {{blank_1}}, आपका ऑर्डर {{blank_2}} रास्ते में है।' },
      submit: true,
    });
    expect(copy.status).toBe(201);
    expect(env.meta.created[0].template).toMatchObject({ name: 'order_update', language: 'hi', category: 'UTILITY' });

    const del = await env.api('DELETE', `/api/official/numbers/${NUMBER}/templates/${original.id}`);
    expect(del.status).toBe(200);
    expect(env.meta.deleted).toEqual([{ wabaId: WABA, name: 'order_update', templateId: '555001' }]);
    const draftOnly = await env.api('POST', `/api/official/numbers/${NUMBER}/templates`, { draft: { ...draft, name: 'just_a_draft' } });
    await env.api('DELETE', `/api/official/numbers/${NUMBER}/templates/${draftOnly.body.id}`);
    expect(env.meta.deleted).toHaveLength(1);
    // A sync never removes drafts.
    await env.api('POST', `/api/official/numbers/${NUMBER}/templates`, { draft: { ...draft, name: 'keep_me' } });
    await env.s.official.syncTemplates(NUMBER);
    expect((await env.api('GET', `/api/official/numbers/${NUMBER}/templates`)).body.items.map((t: any) => t.name).sort()).toEqual(['keep_me', 'order_update']);
  });
});
