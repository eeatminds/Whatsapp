import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path.startsWith('/') ? path : `/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/auth/')) unauthorizedListeners.forEach(l => l());
    const message = (data as { error?: string })?.error ?? `Request failed (${response.status})`;
    throw new ApiError(response.status, message, (data as { details?: unknown })?.details);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fetch on mount and whenever `path` changes; `poll` refreshes in the background, keeping the old data on screen. */
export function useApi<T>(path: string | null, options: { poll?: number } = {}) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const seq = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      if (!path) return;
      const id = ++seq.current;
      if (!quiet) setLoading(true);
      try {
        const result = await get<T>(path);
        if (id === seq.current) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (id === seq.current) setError(errorMessage(err));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!options.poll || !path) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, options.poll);
    return () => clearInterval(timer);
  }, [load, options.poll, path]);

  return { data, error, loading, reload: () => load(true), setData };
}

// ---------------------------------------------------------------- types (mirror the server)

export type Consent = 'opted_in' | 'unknown' | 'opted_out';
export type WaStatus = 'unknown' | 'valid' | 'invalid';

export interface Tag {
  id: number;
  name: string;
  color: string;
  count?: number;
}

export interface Contact {
  id: number;
  phone: string;
  name: string | null;
  email: string | null;
  attributes: Record<string, string>;
  consent: Consent;
  consentSource: string | null;
  consentAt: string | null;
  waStatus: WaStatus;
  waChatId: string | null;
  waCheckedAt: string | null;
  waCheckPending: boolean;
  source: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ContactFilter {
  q?: string;
  tagId?: number;
  consent?: Consent;
  waStatus?: WaStatus;
  segmentId?: number;
  ids?: number[];
}

export type Condition = {
  field: string;
  op: string;
  value?: string | number;
  key?: string;
};

export interface Rules {
  match: 'all' | 'any';
  conditions: Condition[];
}

export interface Segment {
  id: number;
  name: string;
  description: string | null;
  rules: Rules;
  count?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Media {
  id: number;
  filename: string;
  mimetype: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'document';
  createdAt: string;
}

export interface Template {
  id: number;
  name: string;
  body: string;
  mediaId: number | null;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  name: string;
  status: 'created' | 'initializing' | 'qr_ready' | 'authenticating' | 'ready' | 'disconnected' | 'action_required' | 'failed';
  phone: string | null;
  pushName: string | null;
  connectedAt: string | null;
  lastError?: string | null;
  restriction?: { active?: boolean; kind?: string; expiresAt?: string | null } | null;
  marketingSentToday?: number;
  hold?: { until: string; reason: string } | null;
}

export interface GatewayStatus {
  reachable: boolean;
  lastError: string | null;
  checkedAt: string | null;
  webhookUrl: string;
}

export interface Variant {
  key: 'A' | 'B' | 'C';
  body: string;
  mediaId?: number | null;
  weight: number;
}

export type Audience =
  | { type: 'all'; excludeTagIds: number[] }
  | { type: 'segment'; segmentId: number; excludeTagIds: number[] }
  | { type: 'tags'; tagIds: number[]; excludeTagIds: number[] }
  | { type: 'contacts'; contactIds: number[]; excludeTagIds: number[] };

export interface CampaignOptions {
  perMinute: number;
  respectQuietHours: boolean;
  requireOptIn: boolean;
  appendOptOut: boolean;
  trackLinks: boolean;
  validateNumbers: boolean;
}

export interface CampaignStats {
  total: number;
  queued: number;
  sending: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  optedOut: number;
  failed: number;
  skipped: number;
  unknown: number;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';

export interface Campaign {
  id: number;
  name: string;
  status: CampaignStatus;
  sessionId: string | null;
  audience: Audience;
  variants: Variant[];
  options: CampaignOptions;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
  stats: CampaignStats;
  waitReason?: string | null;
}

export interface CampaignReport {
  campaign: Campaign;
  waitReason: string | null;
  variants: Array<{ key: string; total: number; sent: number; delivered: number; read: number; replied: number; clicked: number; optedOut: number; failed: number }>;
  skipReasons: Array<{ reason: string; label: string; count: number }>;
  failureReasons: Array<{ reason: string; count: number }>;
  timeline: Array<{ hour: string; sent: number; read: number; replied: number }>;
  links: Array<{ code: string; url: string; clicks: number; uniqueClicks: number }>;
  trackingEnabled: boolean;
  estimate: { remaining: number; minutes: number } | null;
}

export interface Step {
  delayMinutes: number;
  body: string;
  mediaId?: number | null;
}

export type Trigger = { type: 'manual' } | { type: 'tag_added'; tagId: number } | { type: 'opted_in' };

export interface Sequence {
  id: number;
  name: string;
  active: boolean;
  sessionId: string | null;
  trigger: Trigger;
  steps: Step[];
  options: { stopOnReply: boolean; respectQuietHours: boolean; requireOptIn: boolean; appendOptOut: boolean };
  counts: { active: number; completed: number; stopped: number };
  createdAt: string;
  updatedAt: string;
}

export interface AutoReply {
  id: number;
  name: string;
  active: boolean;
  priority: number;
  matchType: 'exact' | 'contains' | 'starts_with' | 'regex' | 'any';
  keywords: string[];
  replyBody: string;
  replyMediaId: number | null;
  actions: { addTagIds: number[]; removeTagIds: number[]; setConsent?: 'opted_in' | 'opted_out' | null; enrollSequenceId?: number | null };
  sessionId: string | null;
  cooldownMinutes: number;
  hitCount: number;
  lastHitAt: string | null;
}

export interface Message {
  id: number;
  contactId: number | null;
  sessionId: string;
  direction: 'in' | 'out';
  type: string;
  body: string | null;
  mediaId: number | null;
  status: string;
  sourceType: string;
  sourceId: number | null;
  createdAt: string;
}

export interface Conversation {
  contactId: number;
  name: string | null;
  phone: string;
  consent: Consent;
  lastMessage: string | null;
  lastDirection: 'in' | 'out';
  lastAt: string;
  unread: number;
  sessionId: string;
}

export interface Settings {
  businessName: string;
  timezone: string;
  defaultCountry: string;
  defaultSessionId: string | null;
  quietHours: { enabled: boolean; start: string; end: string };
  sending: { sessionMaxPerMinute: number; dailyCapPerSession: number; frequencyCapHours: number; breakerThreshold: number; defaultPerMinute: number };
  compliance: { optOutKeywords: string[]; optInKeywords: string[]; optOutReply: string; optInReply: string; optOutFooter: string };
  attributionWindowHours: number;
}

export interface SystemInfo {
  gateway: GatewayStatus;
  openwaUrl: string;
  webhookUrl: string;
  publicUrl: string | null;
  trackingEnabled: boolean;
  apiKeyEnabled: boolean;
  demo?: boolean;
  timezone: string;
  pendingReplies: number;
  acceptedMimeTypes: string[];
}

export interface Overview {
  contacts: { total: number; optedIn: number; optedOut: number; unknown: number; valid: number; invalid: number; newLast7Days: number };
  today: { marketingSent: number; totalSent: number; received: number };
  dailyCap: number;
  funnel30d: { sent: number; delivered: number; read: number; replied: number; clicked: number; optedOut: number };
  campaigns: { running: number; scheduled: number; paused: number; completed: number };
  activeDripEnrollments: number;
  unreadConversations: number;
  series: Array<{ date: string; sent: number; delivered: number; read: number; received: number }>;
  gateway: GatewayStatus;
  sessions: Array<{ id: string; name: string; status: string; phone: string | null }>;
}
