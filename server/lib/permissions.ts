import type { FastifyRequest } from 'fastify';

/**
 * Callers are team members who only work the Leads page: see their leads, set the stage and write the
 * call remark. This is the whole list of what they may call; anything not here is refused, so a route
 * added later stays closed to them until it is listed.
 */
const CALLER_ROUTES = new Set([
  'GET /api/contacts',
  'PUT /api/contacts/:id/lead',
  'GET /api/leads/report',
  // Their own leads' calls on the Leads page, and the phone app to record them.
  'GET /api/calls/summary',
  'GET /api/call-app',
]);

export const CALLER_REFUSED = 'Callers can only use the Leads page. Ask your admin for anything else.';

/** True when a caller may use this route (`url` is the route pattern that matched, never the raw URL). */
export function callerMayUse(method: string, url: string): boolean {
  return CALLER_ROUTES.has(`${method === 'HEAD' ? 'GET' : method} ${url}`);
}

export function isCaller(request: FastifyRequest): boolean {
  return request.auth?.user?.role === 'caller';
}

/** Which leads a caller may see: every lead, only those given to them, or only those with one tag. */
export type CallerScope = { type: 'all' } | { type: 'assigned'; userId: number } | { type: 'tag'; tagId: number };

/** The caller's lead scope, or null when the request isn't from a caller. */
export function callerScope(request: FastifyRequest): CallerScope | null {
  const user = request.auth?.user;
  if (user?.role !== 'caller') return null;
  if (user.lead_scope === 'all') return { type: 'all' };
  // A tag scope with no tag set (shouldn't happen) falls back to the safe "only their own leads".
  if (user.lead_scope === 'tag' && user.lead_tag) return { type: 'tag', tagId: user.lead_tag };
  return { type: 'assigned', userId: user.id };
}
