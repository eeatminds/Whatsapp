/**
 * Ready-made examples added to every business once, so owners can see what's possible and start
 * from working wording instead of a blank page: message templates plus auto-replies and drip
 * sequences that are all switched OFF until the owner edits and enables them.
 *
 * Text in [square brackets] is for the owner to replace; {{first_name|there}} and
 * {{business_name}} are filled in automatically when messages are sent.
 */
import type { Db } from '../db/database.js';
import type { Services } from './index.js';

const STARTER_KIT_KEY = 'starter_kit';

const TEMPLATES: Array<{ name: string; body: string }> = [
  {
    name: 'Welcome a new customer',
    body: 'Hi {{first_name|there}}! 👋 Welcome to *{{business_name}}*. Thanks for connecting with us.\n\nSave this number to get our offers and updates first. Reply anytime if you have a question.',
  },
  {
    name: 'Festival offer',
    body: '🪔 Happy [festival name], {{first_name|there}}!\n\nCelebrate with *[20]% off* on [products] at {{business_name}}. Offer valid till [date].\n\nShop now: [link or address]',
  },
  {
    name: 'New arrival',
    body: '✨ Just in at {{business_name}}: *[product name]*!\n\n[One line on why customers will love it]. Limited stock.\n\nReply *YES* to reserve yours, or see it here: [link]',
  },
  {
    name: 'Flash sale (ends tonight)',
    body: '⏰ Flash sale, {{first_name|there}}! *[30]% off* everything till midnight tonight.\n\nUse code *[CODE]* or show this message in store.\n\n[link]',
  },
  {
    name: 'Order confirmed',
    body: 'Thank you for your order, {{first_name|there}}! ✅\n\nOrder: *[order number]*\nAmount: ₹[amount]\nExpected delivery: [date]\n\nWe will message you when it ships.',
  },
  {
    name: 'Out for delivery',
    body: '🚚 Good news, {{first_name|there}}! Your order *[order number]* is out for delivery today.\n\nPlease keep ₹[amount] ready if paying cash on delivery.',
  },
  {
    name: 'Payment reminder',
    body: 'Hi {{first_name|there}}, a gentle reminder that ₹[amount] for [invoice / order number] is due on [date].\n\nPay by UPI to *[UPI ID]* or here: [payment link]. Please ignore this if already paid. 🙏',
  },
  {
    name: 'Appointment reminder',
    body: 'Hi {{first_name|there}}, this is a reminder of your appointment at {{business_name}} on *[date] at [time]*.\n\nReply *1* to confirm or *2* to reschedule.',
  },
  {
    name: 'Thank you + review request',
    body: 'Thank you for choosing {{business_name}}, {{first_name|there}}! 🙏\n\nIf you liked our service, a quick Google review would mean a lot to us: [Google review link]',
  },
  {
    name: 'We miss you (win-back)',
    body: 'Hi {{first_name|there}}, it has been a while! We miss you at {{business_name}}. 💚\n\nHere is *[15]% off* your next visit. Just show this message. Valid till [date].',
  },
  {
    name: 'Birthday wish',
    body: '🎂 Happy birthday, {{first_name|there}}! Wishing you a wonderful year ahead.\n\nA small gift from {{business_name}}: *[offer]* this week, just for you.',
  },
  {
    name: 'Back in stock',
    body: 'Good news, {{first_name|there}}! *[product name]* is back in stock at {{business_name}}. 🎉\n\nIt sold out fast last time. Reply *YES* to reserve one.',
  },
  {
    name: 'Event or workshop invite',
    body: "You're invited, {{first_name|there}}! 📅\n\n*[Event name]*\n🗓 [date], [time]\n📍 [venue or online link]\n\nReply *YES* to book your seat. Limited spots.",
  },
  {
    name: 'Feedback request',
    body: 'Hi {{first_name|there}}, how was your experience with {{business_name}}?\n\nReply with a number from *1* (poor) to *5* (excellent). Your feedback helps us improve. 🙏',
  },
];

/** Adds the starter kit once per business. Safe to call repeatedly. */
export function seedStarterKit(db: Db, services: Services, now: string): boolean {
  if (db.get('SELECT 1 FROM settings WHERE key = ?', STARTER_KIT_KEY)) return false;

  db.tx(() => {
    for (const template of TEMPLATES) services.templates.create(template);

    const newLead = services.tags.ensure('new-lead');
    const purchased = services.tags.ensure('purchased');
    const callback = services.tags.ensure('needs-callback');

    // Drip sequences first, so the greeting rule can hand new leads to the welcome series.
    const welcome = services.sequences.create({
      name: 'New lead welcome series',
      active: false,
      trigger: { type: 'tag_added', tagId: newLead },
      steps: [
        { delayMinutes: 0, body: 'Hi {{first_name|there}}! Thanks for your interest in {{business_name}}. 😊\n\n[One line about what you offer]. Reply with any question, we are happy to help.' },
        { delayMinutes: 24 * 60, body: 'Hi {{first_name|there}}, here is what our customers love most: [best seller or top service].\n\nSee it here: [link]' },
        { delayMinutes: 3 * 24 * 60, body: 'Still thinking it over, {{first_name|there}}? Here is *[10]% off* your first order. Use code *[WELCOME10]*, valid for 7 days.' },
      ],
    });
    services.sequences.create({
      name: 'After purchase: thank you, review, reorder',
      active: false,
      trigger: { type: 'tag_added', tagId: purchased },
      steps: [
        { delayMinutes: 24 * 60, body: 'Thank you for shopping with {{business_name}}, {{first_name|there}}! 🙏 We hope you love it. Reply here if you need anything.' },
        { delayMinutes: 6 * 24 * 60, body: 'Hi {{first_name|there}}, how are you finding your purchase? A quick Google review would help us a lot: [Google review link]' },
        { delayMinutes: 23 * 24 * 60, body: 'Time for a refill, {{first_name|there}}? Reorder in one tap: [link]. As a returning customer you get *[5]% off*.' },
      ],
    });
    services.sequences.create({
      name: 'Win back inactive customers',
      active: false,
      trigger: { type: 'manual' },
      steps: [
        { delayMinutes: 0, body: 'Hi {{first_name|there}}, we miss you at {{business_name}}! 💚 Here is *[15]% off* your next order. Valid till [date].' },
        { delayMinutes: 5 * 24 * 60, body: 'Last reminder, {{first_name|there}}: your *[15]% off* ends soon. [link]' },
      ],
    });

    const rules = [
      {
        name: 'Greeting menu (hi / hello)',
        priority: 10,
        matchType: 'exact',
        keywords: ['hi', 'hello', 'hey', 'hii', 'namaste', 'hi there'],
        replyBody:
          'Hi {{first_name|there}}! 👋 Welcome to *{{business_name}}*.\n\nReply with a number:\n*1* Price list\n*2* Location and timings\n*3* Talk to our team',
        actions: { addTagIds: [newLead], removeTagIds: [], enrollSequenceId: welcome.id },
        cooldownMinutes: 12 * 60,
      },
      {
        name: 'Price list (1 / price)',
        priority: 20,
        matchType: 'exact',
        keywords: ['1', 'price', 'prices', 'price list', 'rate', 'rates', 'menu'],
        replyBody: 'Here is our price list 👇\n\n[Item 1] - ₹[price]\n[Item 2] - ₹[price]\n[Item 3] - ₹[price]\n\nTip: attach your price list image or PDF to this reply.',
        cooldownMinutes: 60,
      },
      {
        name: 'Location and timings (2 / address)',
        priority: 30,
        matchType: 'exact',
        keywords: ['2', 'location', 'address', 'timing', 'timings', 'where', 'directions'],
        replyBody: '📍 *{{business_name}}*\n[Full address]\nGoogle Maps: [maps link]\n\n🕙 Open [Mon-Sat], [10 am - 8 pm]',
        cooldownMinutes: 60,
      },
      {
        name: 'Talk to a person (3 / call me)',
        priority: 40,
        matchType: 'exact',
        keywords: ['3', 'call', 'call me', 'agent', 'human', 'talk to someone'],
        replyBody: 'Sure! Someone from our team will reply to you here shortly. 🙏',
        actions: { addTagIds: [callback], removeTagIds: [] },
        cooldownMinutes: 60,
      },
      {
        name: 'Order status question',
        priority: 50,
        matchType: 'contains',
        keywords: ['order status', 'where is my order', 'track order', 'tracking', 'delivery status'],
        replyBody: 'Please share your *order number* and we will check the status for you right away. 📦',
        cooldownMinutes: 60,
      },
      {
        name: 'Away message (any other message)',
        priority: 900,
        matchType: 'any',
        keywords: [],
        replyBody: 'Thanks for messaging {{business_name}}! 🙏 We reply between [10 am and 7 pm, Mon-Sat]. We will get back to you soon.',
        cooldownMinutes: 24 * 60,
      },
    ];
    for (const rule of rules) services.autoReplies.create({ ...rule, active: false });

    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', STARTER_KIT_KEY, JSON.stringify({ seededAt: now }));
  });
  return true;
}
