import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * In-process stand-in for the OpenWA gateway, speaking the same HTTP contract (X-API-Key auth,
 * /api/sessions/..., error bodies) so tests exercise the real OpenWAClient end to end.
 */

export interface FakeSession {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  pushName: string | null;
  connectedAt: string | null;
  createdAt: string;
}

export interface FakeWebhook {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
}

export interface SentRecord {
  sessionId: string;
  kind: 'text' | 'image' | 'video' | 'audio' | 'document';
  chatId: string;
  text?: string;
  caption?: string;
  mimetype?: string;
  messageId: string;
}

type Failure = { status: number; body?: Record<string, unknown> };

export interface FakeOpenWA {
  url: string;
  apiKey: string;
  sessions: FakeSession[];
  webhooks: FakeWebhook[];
  sent: SentRecord[];
  /** Numbers (digits) that are NOT on WhatsApp. Everything else "exists". */
  notOnWhatsApp: Set<string>;
  lidMap: Map<string, string>;
  /** Failures returned for the next send calls, in order. */
  failNextSends: Failure[];
  /** When set, every send fails with this until cleared. */
  failAllSends: Failure | null;
  addSession(name: string, status?: string, phone?: string): FakeSession;
  close(): Promise<void>;
}

/** A QR-looking SVG (finder patterns + pseudo-random modules) so the demo's link screen renders. */
function mockQrDataUrl(seed: string): string {
  const n = 29;
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const cells: string[] = [];
  const finder = (x: number, y: number) => {
    const inBox = (i: number, j: number) => i >= x && i < x + 7 && j >= y && j < y + 7;
    return (i: number, j: number) => inBox(i, j) && (i === x || i === x + 6 || j === y || j === y + 6 || (i >= x + 2 && i <= x + 4 && j >= y + 2 && j <= y + 4));
  };
  const finders = [finder(0, 0), finder(n - 7, 0), finder(0, n - 7)];
  const reserved = (i: number, j: number) => (i < 8 && j < 8) || (i >= n - 8 && j < 8) || (i < 8 && j >= n - 8);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      h = (h * 1103515245 + 12345) >>> 0;
      const on = reserved(i, j) ? finders.some(f => f(i, j)) : (h >>> 16) % 2 === 0;
      if (on) cells.push(`<rect x="${i + 2}" y="${j + 2}" width="1" height="1"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#111">${cells.join('')}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export interface SimulateOptions {
  /** Share of messages that get a read receipt (the rest stop at delivered). */
  readRate: number;
  /** Share of recipients who reply. */
  replyRate: number;
  replies: string[];
  /** Base delay for receipts; each gets some jitter. */
  delayMs: number;
}

/** POST an event to a registered webhook exactly the way OpenWA does (HMAC over the raw body). */
export async function deliverWebhook(hook: FakeWebhook, event: string, data: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    sessionId: hook.sessionId,
    idempotencyKey: `${event}_${randomUUID()}`,
    deliveryId: `dlv_${randomUUID()}`,
    data,
  });
  const signature = 'sha256=' + createHmac('sha256', hook.secret).update(body).digest('hex');
  await fetch(hook.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OpenWA-Event': event, 'X-OpenWA-Signature': signature },
    body,
  }).catch(() => undefined);
}

export async function startFakeOpenWA(options: { apiKey?: string; port?: number; simulate?: SimulateOptions } = {}): Promise<FakeOpenWA> {
  const apiKey = options.apiKey ?? 'test-openwa-key';
  let counter = 0;
  const state: Omit<FakeOpenWA, 'url' | 'close' | 'addSession'> = {
    apiKey,
    sessions: [],
    webhooks: [],
    sent: [],
    notOnWhatsApp: new Set(),
    lidMap: new Map(),
    failNextSends: [],
    failAllSends: null,
  };

  const addSession = (name: string, status = 'ready', phone = '919900000001'): FakeSession => {
    const session: FakeSession = {
      id: randomUUID(),
      name,
      status,
      phone: status === 'ready' ? phone : null,
      pushName: status === 'ready' ? 'Shop' : null,
      connectedAt: status === 'ready' ? new Date().toISOString() : null,
      createdAt: new Date().toISOString(),
    };
    state.sessions.push(session);
    return session;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.headers['x-api-key'] !== apiKey) return json(res, 401, { statusCode: 401, message: 'Invalid API key' });
      const url = new URL(req.url ?? '/', 'http://fake');
      const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sessions', ...]
      const method = req.method ?? 'GET';
      if (parts[0] !== 'api') return json(res, 404, { message: 'not found' });

      if (parts[1] === 'health') return json(res, 200, { status: 'ok' });
      if (parts[1] !== 'sessions') return json(res, 404, { message: 'not found' });

      if (parts.length === 2) {
        if (method === 'GET') return json(res, 200, state.sessions);
        if (method === 'POST') {
          const body = await readBody(req);
          if (state.sessions.some(s => s.name === body.name)) return json(res, 409, { statusCode: 409, message: 'Session name already exists' });
          return json(res, 201, addSession(String(body.name), 'created'));
        }
      }
      const session = state.sessions.find(s => s.id === parts[2]);
      if (!session) return json(res, 404, { statusCode: 404, message: `Session '${parts[2]}' not found` });
      const rest = parts.slice(3);

      if (rest.length === 0) {
        if (method === 'GET') return json(res, 200, session);
        if (method === 'DELETE') {
          state.sessions.splice(state.sessions.indexOf(session), 1);
          return json(res, 200, { success: true });
        }
      }
      if (rest[0] === 'start' && method === 'POST') {
        session.status = 'qr_ready';
        return json(res, 201, session);
      }
      if ((rest[0] === 'stop' || rest[0] === 'logout') && method === 'POST') {
        session.status = 'disconnected';
        return json(res, 201, { success: true });
      }
      if (rest[0] === 'qr' && method === 'GET') {
        if (session.status !== 'qr_ready') return json(res, 400, { statusCode: 400, message: 'No QR available' });
        return json(res, 200, { qrCode: mockQrDataUrl(session.id), status: session.status });
      }
      if (rest[0] === 'pairing-code' && method === 'POST') return json(res, 201, { pairingCode: 'ABCD1234', status: session.status });

      if (rest[0] === 'webhooks') {
        if (rest.length === 1 && method === 'GET') return json(res, 200, state.webhooks.filter(w => w.sessionId === session.id));
        if (rest.length === 1 && method === 'POST') {
          const body = await readBody(req);
          const hook: FakeWebhook = {
            id: randomUUID(),
            sessionId: session.id,
            url: String(body.url),
            events: body.events as string[],
            secret: String(body.secret),
            active: true,
          };
          state.webhooks.push(hook);
          return json(res, 201, hook);
        }
        const hook = state.webhooks.find(w => w.id === rest[1]);
        if (hook && method === 'PUT') {
          Object.assign(hook, await readBody(req));
          return json(res, 200, hook);
        }
        return json(res, 404, { message: 'webhook not found' });
      }

      if (rest[0] === 'contacts' && rest[1] === 'check' && method === 'GET') {
        if (session.status !== 'ready') return json(res, 409, { statusCode: 409, message: 'Engine not ready' });
        const number = decodeURIComponent(rest[2]);
        const exists = !state.notOnWhatsApp.has(number);
        return json(res, 200, { number, exists, whatsappId: exists ? `${number}@c.us` : null });
      }
      if (rest[0] === 'contacts' && rest[2] === 'phone' && method === 'GET') {
        const contactId = decodeURIComponent(rest[1]);
        return json(res, 200, { contactId, phone: state.lidMap.get(contactId) ?? null });
      }

      if (rest[0] === 'messages' && method === 'POST' && rest[1]?.startsWith('send-')) {
        const kind = rest[1].slice(5) as SentRecord['kind'];
        if (session.status !== 'ready') return json(res, 409, { statusCode: 409, message: 'Session is not ready' });
        const failure = state.failAllSends ?? state.failNextSends.shift();
        if (failure) return json(res, failure.status, { statusCode: failure.status, message: 'Injected failure', ...failure.body });
        const body = await readBody(req);
        const messageId = `true_${String(body.chatId)}_3EB0${String(++counter).padStart(6, '0')}`;
        state.sent.push({
          sessionId: session.id,
          kind,
          chatId: String(body.chatId),
          text: body.text as string | undefined,
          caption: body.caption as string | undefined,
          mimetype: body.mimetype as string | undefined,
          messageId,
        });
        if (options.simulate) simulateReceipts(session.id, String(body.chatId), messageId, options.simulate);
        return json(res, 201, { messageId, timestamp: Math.floor(Date.now() / 1000) });
      }
      return json(res, 404, { message: `no fake route for ${method} ${url.pathname}` });
    })().catch(error => json(res, 500, { message: String(error) }));
  });

  const simulateReceipts = (sessionId: string, chatId: string, messageId: string, sim: SimulateOptions) => {
    const hooks = () => state.webhooks.filter(w => w.sessionId === sessionId && w.active);
    const later = (ms: number, fn: () => void) => setTimeout(fn, ms + Math.random() * sim.delayMs).unref();
    later(sim.delayMs, () => {
      for (const hook of hooks()) void deliverWebhook(hook, 'message.ack', { id: messageId, messageId, status: 'delivered', ack: 2 });
    });
    if (Math.random() < sim.readRate) {
      later(sim.delayMs * 3, () => {
        for (const hook of hooks()) void deliverWebhook(hook, 'message.ack', { id: messageId, messageId, status: 'read', ack: 3 });
      });
      if (Math.random() < sim.replyRate && chatId.endsWith('@c.us')) {
        later(sim.delayMs * 6, () => {
          const text = sim.replies[Math.floor(Math.random() * sim.replies.length)];
          for (const hook of hooks()) {
            void deliverWebhook(hook, 'message.received', {
              id: `in_${randomUUID()}`,
              from: chatId,
              to: 'me@c.us',
              body: text,
              type: 'text',
              timestamp: Math.floor(Date.now() / 1000),
              isGroup: false,
              kind: 'individual',
              hasMedia: false,
              contact: {},
            });
          }
        });
      }
    }
  };

  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    addSession,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }) as FakeOpenWA;
}
