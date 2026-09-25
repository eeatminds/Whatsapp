/**
 * Demo mode: runs WA Reach against a simulated OpenWA gateway, with sample contacts, templates,
 * automations and two weeks of campaign history. Nothing is sent to WhatsApp.
 *
 *   npm run demo            -> http://localhost:3000  (password: demo-password)
 *
 * The simulated gateway behaves like OpenWA from the app's point of view: sessions, signed
 * webhooks, delivery/read receipts and customer replies arrive over HTTP.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOpenWA } from '../test/fake-openwa.js';
import { loadConfig } from '../server/config.js';
import { openDatabase, nowIso } from '../server/db/database.js';
import { OpenWAClient } from '../server/openwa/client.js';
import { createServices } from '../server/services/index.js';
import { buildApp } from '../server/app.js';
import type { Core } from '../server/context.js';

const PORT = Number(process.env.PORT ?? 3000);
const here = dirname(fileURLToPath(import.meta.url));

const FIRST = ['Aarav', 'Priya', 'Rohan', 'Ananya', 'Vikram', 'Meera', 'Karthik', 'Sneha', 'Arjun', 'Divya', 'Rahul', 'Isha', 'Aditya', 'Kavya', 'Nikhil', 'Pooja', 'Siddharth', 'Neha', 'Varun', 'Riya', 'Manish', 'Tanvi', 'Harsh', 'Anjali', 'Kunal', 'Shreya', 'Amit', 'Nisha', 'Yash', 'Aditi', 'Rajesh', 'Swati', 'Deepak', 'Lakshmi', 'Suresh', 'Farah', 'Imran', 'Zoya', 'Gaurav', 'Pallavi', 'Naveen', 'Asha', 'Ravi', 'Sunita', 'Tarun', 'Bhavna', 'Omkar', 'Jyoti'];
const LAST = ['Sharma', 'Iyer', 'Reddy', 'Nair', 'Gupta', 'Kulkarni', 'Menon', 'Rao', 'Singh', 'Patel', 'Joshi', 'Das', 'Khan', 'Bose', 'Pillai', 'Shetty'];
const CITIES = ['Bengaluru', 'Mumbai', 'Pune', 'Chennai', 'Hyderabad', 'Delhi', 'Kochi'];

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function main(): Promise<void> {
  const random = rng(42);
  // Receipts and replies are simulated only once the app is listening (history is seeded directly).
  const gatewayOptions: NonNullable<Parameters<typeof startFakeOpenWA>[0]> = { apiKey: 'demo-openwa-key' };
  const fake = await startFakeOpenWA(gatewayOptions);
  const session = fake.addSession('demo-store', 'ready', '919900011122');

  const dataDir = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), 'wa-reach-demo-'));
  const config = loadConfig({
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(PORT),
    OPENWA_URL: fake.url,
    OPENWA_API_KEY: fake.apiKey,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? 'demo-password',
    PUBLIC_URL: `http://localhost:${PORT}`,
    WEBHOOK_URL: `http://127.0.0.1:${PORT}/webhooks/openwa`,
    APP_API_KEY: 'demo-api-key-0123456789',
  });
  let offset = 0;
  const core: Core = {
    db: openDatabase(config.dbPath),
    config,
    openwa: new OpenWAClient({ baseUrl: fake.url, apiKey: fake.apiKey }),
    clock: () => new Date(Date.now() + offset),
    log: { info: () => {}, warn: () => {}, error: console.error, debug: () => {} },
  };
  const s = createServices(core);

  // ---------------------------------------------------------------- settings, tags, contacts
  s.settings.update({
    businessName: 'Chai & Co.',
    defaultSessionId: session.id,
    quietHours: { enabled: false, start: '21:00', end: '09:00' },
    sending: { sessionMaxPerMinute: 30, defaultPerMinute: 20 },
  });
  const tag = (name: string, color: string) => s.tags.create({ name, color }).id;
  const vip = tag('vip', '#9333EA');
  const diwali = tag('diwali-2026', '#EA580C');
  const web = tag('website-lead', '#2563EB');
  const wholesale = tag('wholesale', '#0891B2');

  offset = -16 * 86_400_000;
  const rows = ['phone,first name,last name,city,last order,tags'];
  for (let i = 0; i < 48; i++) {
    const tags = [random() < 0.25 ? 'vip' : '', random() < 0.3 ? 'website-lead' : '', random() < 0.12 ? 'wholesale' : ''].filter(Boolean).join(';');
    rows.push(`98450${String(10000 + i * 137).slice(-5)},${FIRST[i]},${LAST[i % LAST.length]},${CITIES[i % CITIES.length]},${Math.round(400 + random() * 4000)},"${tags}"`);
  }
  s.contacts.importCsv({
    csv: rows.join('\n'),
    mapping: { '0': 'phone', '1': 'first_name', '2': 'last_name', '3': 'attr:city', '4': 'attr:last_order', '5': 'tags' },
    consent: 'opted_in',
    consentSource: 'Store checkout opt-in',
  });
  const everyone = s.contacts.ids({});
  s.contacts.addTags(everyone.filter(() => random() < 0.6), [diwali]);

  // ---------------------------------------------------------------- templates, segments, automations
  s.templates.create({ name: 'Festive offer', body: 'Hi {{first_name|there}} 🪔\n\nOur *Diwali hampers* are here! 20% off for {{city}} customers till Sunday.\n\nOrder: https://chaico.example/diwali' });
  s.templates.create({ name: 'Order ready', body: 'Hi {{first_name}}, your order is packed and ready for pickup at our {{city}} store. See you soon!' });
  s.templates.create({ name: 'Win-back', body: "We miss you, {{first_name|friend}}! Here's ₹150 off your next order with code *COMEBACK150*." });
  s.segments.create({ name: 'Pune & Mumbai VIPs', rules: { match: 'all', conditions: [{ field: 'tag', op: 'has', value: vip }, { field: 'attribute', key: 'city', op: 'contains', value: 'u' }] } });
  s.segments.create({ name: 'Big spenders', description: 'Last order above ₹2,500', rules: { match: 'all', conditions: [{ field: 'attribute', key: 'last_order', op: 'gt', value: '2500' }] } });
  const welcome = s.sequences.create({
    name: 'Website lead welcome',
    trigger: { type: 'tag_added', tagId: web },
    steps: [
      { delayMinutes: 0, body: 'Hi {{first_name|there}}! Thanks for your interest in Chai & Co. ☕ Reply *MENU* anytime to see our blends.' },
      { delayMinutes: 1440, body: 'Our bestseller is the Masala Chai starter kit. Want a free sample with your first order?' },
      { delayMinutes: 4320, body: 'Last nudge from us: use *WELCOME10* for 10% off your first order this week.' },
    ],
  });
  s.autoReplies.create({ name: 'Price & menu', matchType: 'contains', keywords: ['price', 'menu', 'catalogue', 'rate'], replyBody: 'Here is our full menu with prices: https://chaico.example/menu\n\nReply with a product name to order.', actions: { addTagIds: [web] }, priority: 10 });
  s.autoReplies.create({ name: 'Store hours', matchType: 'contains', keywords: ['hours', 'timing', 'open'], replyBody: 'We are open 8am–10pm, every day. 🕗', priority: 20 });
  s.autoReplies.create({ name: 'After-hours fallback', matchType: 'any', replyBody: 'Thanks for writing to Chai & Co.! A team member will reply shortly.', priority: 900, cooldownMinutes: 720 });
  void welcome;

  // ---------------------------------------------------------------- two weeks of history
  const historic = async (name: string, daysAgo: number, audience: object, body: string, variants?: Array<{ key: 'A' | 'B'; body: string; weight: number }>) => {
    offset = -daysAgo * 86_400_000;
    const c = s.campaigns.create({ name, audience, variants: variants ?? [{ key: 'A', body, weight: 100 }], options: { perMinute: 60, respectQuietHours: false } });
    s.campaigns.launch(c.id, {});
    for (let i = 0; i < 400 && s.campaigns.get(c.id).status === 'running'; i++) {
      offset += 2100;
      await s.dispatcher.tick();
    }
    // Receipts and replies, delivered through the same webhook processor live traffic uses.
    const sent = core.db.all<{ wa_message_id: string; contact_id: number; variant: string }>(
      "SELECT wa_message_id, contact_id, variant FROM campaign_recipients WHERE campaign_id = ? AND status = 'sent'",
      c.id,
    );
    for (const r of sent) {
      offset += 20_000;
      if (random() < 0.95) await s.inbound.handle({ event: 'message.ack', sessionId: session.id, data: { messageId: r.wa_message_id, status: 'delivered' } });
      const readBoost = r.variant === 'B' ? 0.12 : 0;
      if (random() < 0.66 + readBoost) {
        await s.inbound.handle({ event: 'message.ack', sessionId: session.id, data: { messageId: r.wa_message_id, status: 'read' } });
        const phone = core.db.get<{ phone: string }>('SELECT phone FROM contacts WHERE id = ?', r.contact_id)!.phone;
        const roll = random();
        const reply = roll < 0.18 ? 'Interested! Do you deliver?' : roll < 0.23 ? 'price?' : roll < 0.25 ? 'STOP' : null;
        if (reply) {
          offset += 60_000;
          await s.inbound.handle({
            event: 'message.received',
            sessionId: session.id,
            data: { id: `hist_${c.id}_${r.contact_id}`, from: `${phone}@c.us`, body: reply, type: 'text', kind: 'individual' },
          });
        }
      }
    }
    // Clicks from a share of readers.
    const links = core.db.all<{ code: string }>('SELECT code FROM links WHERE campaign_id = ?', c.id);
    if (links.length) {
      const tokens = core.db.all<{ token: string }>("SELECT token FROM campaign_recipients WHERE campaign_id = ? AND status = 'read'", c.id);
      for (const t of tokens) if (random() < 0.35) s.campaigns.recordClick(links[0].code, t.token, 'Mozilla/5.0 (Linux; Android 14)', false);
    }
    // Flush any queued auto-replies while still "in the past".
    for (let i = 0; i < 60; i++) {
      offset += 5000;
      await s.dispatcher.tick();
    }
  };

  await historic('Monsoon chai week', 13, { type: 'all' }, 'Hi {{first_name}}, rainy days call for *ginger chai* ☔ 15% off all week: https://chaico.example/monsoon');
  await historic('Diwali hampers – A/B', 6, { type: 'tags', tagIds: [diwali] }, '', [
    { key: 'A', body: 'Hi {{first_name}}! Diwali hampers are live 🪔 https://chaico.example/diwali', weight: 50 },
    { key: 'B', body: '{{first_name}}, your {{city}} store has *limited* Diwali hampers left 🪔 Reserve yours: https://chaico.example/diwali', weight: 50 },
  ]);
  await historic('VIP early access', 2, { type: 'tags', tagIds: [vip] }, 'Hi {{first_name}}, as a VIP you get first pick of our new *Kashmiri Kahwa* blend ✨ https://chaico.example/kahwa');

  // Scheduled + draft campaigns so every state is visible.
  offset = 0;
  const scheduled = s.campaigns.create({ name: 'Weekend win-back', audience: { type: 'all' }, variants: [{ key: 'A', body: "We miss you, {{first_name|friend}}! ₹150 off with *COMEBACK150* 🎁", weight: 100 }] });
  s.campaigns.launch(scheduled.id, { scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  s.campaigns.create({ name: 'Wholesale price list (draft)', audience: { type: 'tags', tagIds: [wholesale] }, variants: [{ key: 'A', body: 'Hello {{first_name}}, our updated wholesale price list is attached.', weight: 100 }] });

  // A couple of fresh website leads start the drip live.
  s.contacts.upsert({ phone: '+91 98450 77001', name: 'Farhan Ali', tags: ['website-lead'], consent: 'opted_in', consentSource: 'Website form' });
  s.contacts.upsert({ phone: '+91 98450 77002', name: 'Gita Menon', tags: ['website-lead'], consent: 'opted_in', consentSource: 'Website form' });

  // ---------------------------------------------------------------- serve
  const app = await buildApp(core, s, { staticDir: join(here, '..', 'dist', 'web') });
  s.dispatcher.start();
  await app.listen({ host: '127.0.0.1', port: PORT });
  await s.sessions.syncWebhooks();
  gatewayOptions.simulate = {
    readRate: 0.72,
    replyRate: 0.22,
    delayMs: 2500,
    replies: ['Is this available in Pune?', 'price?', 'Interested! Share the catalogue', 'What are your store hours?', 'Thanks 🙏', 'STOP', 'Can I pay by UPI?'],
  };

  // A live campaign that sends while you watch.
  const live = s.campaigns.create({
    name: 'New Kahwa launch',
    audience: { type: 'all' },
    variants: [{ key: 'A', body: 'Hi {{first_name}} ✨ Our new *Kashmiri Kahwa* is here. Try it: https://chaico.example/kahwa', weight: 100 }],
    options: { perMinute: 12 },
  });
  s.campaigns.launch(live.id, {});

  console.log(`\n  WA Reach demo running at http://localhost:${PORT}`);
  console.log(`  Password: ${config.adminPassword}`);
  console.log(`  Simulated OpenWA gateway: ${fake.url} (no real WhatsApp messages are sent)\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
