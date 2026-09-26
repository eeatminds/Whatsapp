import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Core } from '../context.js';
import type { Services } from '../services/index.js';
import { badRequest } from '../lib/errors.js';
import { chatIdFor } from '../lib/phone.js';
import { contactFilterSchema } from '../services/contacts.js';
import { matchesRule, normalizeKeywordText } from '../services/auto-replies.js';
import { ACCEPTED_MIME_TYPES } from '../services/media.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const sessionParam = z.object({ id: z.string().min(1).max(100) });
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

function params<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  return schema.parse(request.params);
}

function filterFromQuery(query: unknown) {
  return contactFilterSchema.parse(query ?? {});
}

export interface PlatformInfo {
  /** Setup video the platform admin chose to show beside the official-number guide. */
  metaGuideVideoUrl(): string | null;
  supportContact(): string | null;
}

export async function registerApiRoutes(app: FastifyInstance, core: Core, s: Services, platform?: PlatformInfo): Promise<void> {
  /** Internal addresses and raw gateway errors are for the platform admin only. */
  const gatewayFor = (request: FastifyRequest) => {
    const gateway = s.sessions.gatewayStatus();
    if (request.auth?.user?.role === 'platform_admin') return gateway;
    return { ...gateway, webhookUrl: '', lastError: gateway.lastError ? 'The WhatsApp gateway is not reachable right now. Try again in a few minutes.' : null };
  };

  // ---------------------------------------------------------------- system

  app.get('/system', async request => {
    const settings = s.settings.get();
    const isAdmin = request.auth?.user?.role === 'platform_admin';
    return {
      gateway: gatewayFor(request),
      openwaUrl: isAdmin ? core.config.openwa.url : null,
      webhookUrl: isAdmin ? core.config.webhookUrl : null,
      publicUrl: core.config.publicUrl,
      trackingEnabled: !!core.config.publicUrl,
      apiKeyEnabled: !!core.config.apiKey,
      demo: process.env.WA_REACH_DEMO === '1',
      timezone: settings.timezone,
      pendingReplies: s.outbox.pendingCount(),
      acceptedMimeTypes: ACCEPTED_MIME_TYPES,
    };
  });

  app.post('/system/sync-webhooks', async () => ({ results: await s.sessions.syncWebhooks() }));

  app.get('/overview', async request => {
    const sessions = await s.sessions.list();
    return {
      ...s.analytics.overview(14),
      gateway: gatewayFor(request),
      sessions: sessions.map(session => ({ id: session.id, name: session.name, status: session.status, phone: session.phone })),
    };
  });

  // ---------------------------------------------------------------- WhatsApp numbers (OpenWA sessions)

  app.get('/sessions', async request => {
    const sessions = await s.sessions.list(true);
    const tz = s.settings.get().timezone;
    const templates = s.official.templateCounts();
    return {
      gateway: gatewayFor(request),
      defaultSessionId: s.settings.get().defaultSessionId,
      dailyCap: s.settings.get().sending.dailyCapPerSession,
      items: sessions.map(session => ({
        ...session,
        marketingSentToday: s.messages.marketingSentToday(session.id, tz),
        hold: s.dispatcher.sessionBackoff(session.id),
        templates: session.official ? (templates.get(session.official.wabaId) ?? { approved: 0, total: 0 }) : undefined,
      })),
    };
  });

  app.post('/sessions', async request => {
    const { name } = z.object({ name: z.string().trim() }).parse(request.body);
    const session = await s.sessions.create(name);
    if (!s.settings.get().defaultSessionId) s.settings.update({ defaultSessionId: session.id });
    return session;
  });

  app.post('/sessions/:id/start', async request => {
    await s.sessions.start(params(sessionParam, request).id);
    return { ok: true };
  });
  app.post('/sessions/:id/stop', async request => {
    await s.sessions.stop(params(sessionParam, request).id);
    return { ok: true };
  });
  app.post('/sessions/:id/logout', async request => {
    await s.sessions.logout(params(sessionParam, request).id);
    return { ok: true };
  });
  app.delete('/sessions/:id', async request => {
    const { id } = params(sessionParam, request);
    await s.sessions.remove(id);
    if (s.settings.get().defaultSessionId === id) s.settings.update({ defaultSessionId: null });
    return { ok: true };
  });
  app.get('/sessions/:id/qr', async request => s.sessions.qr(params(sessionParam, request).id));
  app.post('/sessions/:id/pairing-code', async request => {
    const { phone } = z.object({ phone: z.string() }).parse(request.body);
    return s.sessions.pairingCode(params(sessionParam, request).id, phone);
  });

  // ---------------------------------------------------------------- official numbers (Meta Cloud API)

  app.get('/official/setup', async () => ({
    ...s.official.setup(),
    guideVideoUrl: platform?.metaGuideVideoUrl() ?? null,
    supportContact: platform?.supportContact() ?? null,
  }));

  app.post('/official/numbers', async (request, reply) => {
    const session = await s.sessions.addOfficial(request.body);
    if (!s.settings.get().defaultSessionId) s.settings.update({ defaultSessionId: session.id });
    s.sessions.invalidate();
    return reply.status(201).send(session);
  });
  app.patch('/official/numbers/:id', async request => s.official.update(params(sessionParam, request).id, request.body));
  app.post('/official/numbers/:id/check', async request => s.official.check(params(sessionParam, request).id));
  app.post('/official/numbers/:id/sync-templates', async request => ({ items: await s.official.syncTemplates(params(sessionParam, request).id) }));
  app.get('/official/numbers/:id/templates', async request => ({ items: s.official.templates(params(sessionParam, request).id) }));

  // ---------------------------------------------------------------- contacts

  app.get('/contacts', async request => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = pageQuery.parse(query);
    return s.contacts.list(filterFromQuery({ ...query, page: undefined, pageSize: undefined }), page, pageSize);
  });

  app.post('/contacts', async (request, reply) => {
    const result = s.contacts.upsert(request.body);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.get('/contacts/attributes', async () => ({ keys: s.contacts.attributeKeys() }));

  app.get('/contacts/export.csv', async (request, reply) => {
    const csv = s.contacts.exportCsv(filterFromQuery(request.query));
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });

  app.post('/contacts/import/preview', { bodyLimit: 30 * 1024 * 1024 }, async request => {
    const { csv } = z.object({ csv: z.string().min(1) }).parse(request.body);
    return s.contacts.previewImport(csv);
  });

  app.post('/contacts/import', { bodyLimit: 30 * 1024 * 1024 }, async request => s.contacts.importCsv(request.body));

  app.post('/contacts/bulk', async request => s.contacts.bulk(request.body));

  app.post('/contacts/ids', async request => {
    const { filter } = z.object({ filter: contactFilterSchema }).parse(request.body);
    return { ids: s.contacts.ids(filter) };
  });

  app.get('/contacts/:id', async request => {
    const { id } = params(idParam, request);
    const contact = s.contacts.get(id);
    const campaigns = core.db.all<Record<string, unknown>>(
      `SELECT r.campaign_id AS campaignId, c.name, r.variant, r.status, r.error, r.sent_at AS sentAt, r.read_at AS readAt,
              r.replied_at AS repliedAt, r.clicked_at AS clickedAt
         FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE r.contact_id = ? ORDER BY r.id DESC LIMIT 50`,
      id,
    );
    return { contact, messages: s.messages.thread(id, 50), campaigns, sequences: s.sequences.contactEnrollments(id) };
  });

  app.patch('/contacts/:id', async request => s.contacts.update(params(idParam, request).id, request.body));

  app.delete('/contacts/:id', async request => {
    s.contacts.delete(params(idParam, request).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- tags

  app.get('/tags', async () => s.tags.list());
  app.post('/tags', async (request, reply) => reply.status(201).send(s.tags.create(request.body)));
  app.patch('/tags/:id', async request => s.tags.update(params(idParam, request).id, request.body));
  app.delete('/tags/:id', async request => {
    s.tags.delete(params(idParam, request).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- segments

  app.get('/segments', async () => s.segments.list());
  app.post('/segments', async (request, reply) => reply.status(201).send(s.segments.create(request.body)));
  app.post('/segments/preview', async request => s.segments.preview((request.body as { rules?: unknown })?.rules ?? request.body));
  app.get('/segments/:id', async request => s.segments.get(params(idParam, request).id));
  app.patch('/segments/:id', async request => s.segments.update(params(idParam, request).id, request.body));
  app.delete('/segments/:id', async request => {
    s.segments.delete(params(idParam, request).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- media

  app.get('/media', async () => s.media.list());
  app.post('/media', { bodyLimit: 45 * 1024 * 1024 }, async (request, reply) => reply.status(201).send(await s.media.upload(request.body)));
  app.get('/media/:id/file', async (request, reply) => {
    const { media, data } = await s.media.read(params(idParam, request).id);
    // Images, video and audio display inline; documents always download, never render in the page.
    const inline = /^(image|video|audio)\//.test(media.mimetype);
    const asciiName = media.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
    return reply
      .header('Content-Type', media.mimetype)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(media.filename)}`)
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox")
      .header('Cache-Control', 'private, max-age=86400')
      .send(data);
  });
  app.delete('/media/:id', async request => {
    await s.media.delete(params(idParam, request).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- templates

  app.get('/templates', async () => s.templates.list());
  app.post('/templates', async (request, reply) => reply.status(201).send(s.templates.create(request.body)));
  app.post('/templates/preview', async request => {
    const { body, contactId } = z.object({ body: z.string().max(5000), contactId: z.coerce.number().int().positive().optional() }).parse(request.body);
    return s.templates.preview(body, contactId);
  });
  app.get('/templates/:id', async request => s.templates.get(params(idParam, request).id));
  app.patch('/templates/:id', async request => s.templates.update(params(idParam, request).id, request.body));
  app.delete('/templates/:id', async request => {
    s.templates.delete(params(idParam, request).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- campaigns

  app.get('/campaigns', async () =>
    s.campaigns.list().map(c => ({ ...c, waitReason: c.status === 'running' ? s.dispatcher.campaignWaitReason(c.id) : null })),
  );
  app.post('/campaigns', async (request, reply) => reply.status(201).send(s.campaigns.create(request.body)));
  app.post('/campaigns/audience-preview', async request => s.campaigns.audiencePreview(request.body));
  app.get('/campaigns/:id', async request => {
    const campaign = s.campaigns.get(params(idParam, request).id);
    return { ...campaign, waitReason: campaign.status === 'running' ? s.dispatcher.campaignWaitReason(campaign.id) : null };
  });
  app.patch('/campaigns/:id', async request => s.campaigns.update(params(idParam, request).id, request.body));
  app.delete('/campaigns/:id', async request => {
    s.campaigns.delete(params(idParam, request).id);
    return { ok: true };
  });
  app.post('/campaigns/:id/launch', async request => {
    const campaign = s.campaigns.launch(params(idParam, request).id, request.body ?? {});
    // Kick the dispatcher so the first message goes out without waiting for the next tick.
    void s.dispatcher.tick().catch(() => undefined);
    return campaign;
  });
  app.post('/campaigns/:id/pause', async request => s.campaigns.pause(params(idParam, request).id, null));
  app.post('/campaigns/:id/resume', async request => s.campaigns.resume(params(idParam, request).id));
  app.post('/campaigns/:id/cancel', async request => s.campaigns.cancel(params(idParam, request).id));
  app.post('/campaigns/:id/duplicate', async (request, reply) => reply.status(201).send(s.campaigns.duplicate(params(idParam, request).id)));
  app.post('/campaigns/:id/test', async request => s.campaigns.testSend(params(idParam, request).id, request.body));
  app.get('/campaigns/:id/report', async request => {
    const { id } = params(idParam, request);
    const report = s.campaigns.report(id);
    return { ...report, waitReason: report.campaign.status === 'running' ? s.dispatcher.campaignWaitReason(id) : null };
  });
  app.get('/campaigns/:id/recipients', async request => {
    const query = z
      .object({ status: z.string().max(20).optional() })
      .and(pageQuery)
      .parse(request.query);
    return s.campaigns.recipients(params(idParam, request).id, query);
  });
  app.get('/campaigns/:id/recipients.csv', async (request, reply) => {
    const { id } = params(idParam, request);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="campaign-${id}-recipients.csv"`)
      .send(s.campaigns.recipientsCsv(id));
  });

  // ---------------------------------------------------------------- drip sequences

  app.get('/sequences', async () => s.sequences.list());
  app.post('/sequences', async (request, reply) => reply.status(201).send(s.sequences.create(request.body)));
  app.get('/sequences/:id', async request => s.sequences.get(params(idParam, request).id));
  app.patch('/sequences/:id', async request => s.sequences.update(params(idParam, request).id, request.body));
  app.delete('/sequences/:id', async request => {
    s.sequences.delete(params(idParam, request).id);
    return { ok: true };
  });
  app.post('/sequences/:id/enroll', async request => {
    const { id } = params(idParam, request);
    const body = z
      .object({ contactIds: z.array(z.coerce.number().int().positive()).max(100_000).optional(), filter: contactFilterSchema.optional() })
      .parse(request.body);
    const contactIds = body.contactIds ?? (body.filter ? s.contacts.ids(body.filter) : []);
    if (contactIds.length === 0) throw badRequest('No contacts selected');
    return s.sequences.enroll(id, contactIds, true);
  });
  app.get('/sequences/:id/enrollments', async request => {
    const { page, pageSize } = pageQuery.parse(request.query);
    return s.sequences.enrollments(params(idParam, request).id, page, pageSize);
  });
  app.post('/sequences/enrollments/:id/stop', async request => {
    s.sequences.stopEnrollment(params(idParam, request).id, 'stopped_manually');
    return { ok: true };
  });

  // ---------------------------------------------------------------- auto-replies

  app.get('/auto-replies', async () => s.autoReplies.list());
  app.post('/auto-replies', async (request, reply) => reply.status(201).send(s.autoReplies.create(request.body)));
  app.post('/auto-replies/test', async request => {
    const { text } = z.object({ text: z.string().max(1000) }).parse(request.body);
    const settings = s.settings.get();
    const keyword = normalizeKeywordText(text);
    if (keyword && settings.compliance.optOutKeywords.some(k => normalizeKeywordText(k) === keyword)) return { match: 'opt_out' };
    if (keyword && settings.compliance.optInKeywords.some(k => normalizeKeywordText(k) === keyword)) return { match: 'opt_in' };
    const rule = s.autoReplies.list().find(r => r.active && matchesRule(r, text));
    return rule ? { match: 'rule', rule } : { match: null };
  });
  app.patch('/auto-replies/:id', async request => s.autoReplies.update(params(idParam, request).id, request.body));
  app.delete('/auto-replies/:id', async request => {
    s.autoReplies.delete(params(idParam, request).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- inbox

  app.get('/inbox', async request => {
    const query = z
      .object({ q: z.string().max(100).optional(), unread: z.enum(['true', 'false']).optional(), view: z.enum(['all', 'unread', 'replied']).optional() })
      .parse(request.query);
    const view = query.view ?? (query.unread === 'true' ? 'unread' : 'all');
    return {
      items: s.messages.conversations({ q: query.q, unreadOnly: view === 'unread', repliedOnly: view === 'replied' }),
      unread: s.messages.unreadCount(),
    };
  });

  app.get('/inbox/:id', async request => {
    const { id } = params(idParam, request);
    const sessionId = s.messages.lastSessionFor(id);
    const contact = s.contacts.get(id);
    // Official numbers can only send free-form messages within 24 hours of the customer's last one.
    const official =
      sessionId && s.official.isOfficial(sessionId)
        ? { windowOpenUntil: s.official.windowOpenUntil(sessionId, contact.waChatId ?? chatIdFor(contact.phone)) }
        : null;
    return { contact, messages: s.messages.thread(id, 300), sessionId, official };
  });

  app.post('/inbox/:id/seen', async request => ({ updated: s.messages.markSeen(params(idParam, request).id) }));

  app.post('/inbox/:id/send', async request => {
    const { id } = params(idParam, request);
    const body = z
      .object({
        text: z.string().max(4096).default(''),
        mediaId: z.coerce.number().int().positive().nullish(),
        sessionId: z.string().min(1).optional(),
      })
      .refine(b => b.text.trim() !== '' || !!b.mediaId, 'Write a message or attach a file')
      .parse(request.body);
    const contact = s.contacts.row(id);
    const sessionId = body.sessionId ?? s.messages.lastSessionFor(id) ?? s.settings.get().defaultSessionId;
    if (!sessionId) throw badRequest('Connect a WhatsApp number first');
    const chatId = contact.wa_chat_id ?? chatIdFor(contact.phone);
    const sent = await s.sender.send(sessionId, chatId, { text: body.text, mediaId: body.mediaId });
    core.db.tx(() => {
      s.messages.recordOutbound({
        contactId: id,
        sessionId,
        chatId,
        waMessageId: sent.messageId,
        body: sent.followUp ? null : body.text,
        mediaId: body.mediaId,
        type: sent.type,
        sourceType: 'manual',
      });
      if (sent.followUp) {
        s.messages.recordOutbound({ contactId: id, sessionId, chatId, waMessageId: sent.followUp.messageId, body: sent.followUp.text, sourceType: 'manual' });
      }
      s.messages.markSeen(id);
    });
    return { messageId: sent.messageId };
  });

  // ---------------------------------------------------------------- settings

  app.get('/settings', async () => s.settings.get());
  app.put('/settings', async request => {
    // Sending limits are part of the plan the platform admin sells; a business can't raise its own.
    const body = { ...((request.body as Record<string, unknown> | null) ?? {}) };
    if (request.auth?.user?.role !== 'platform_admin') delete body.sending;
    return s.settings.update(body);
  });
}
