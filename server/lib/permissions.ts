import type { FastifyRequest } from 'fastify';

/**
 * Callers are team members who only work the Leads page: see their leads, set the stage and write the
 * call remark. This is the whole list of what they may call; anything not here is refused, so a route
 * added later stays closed to them until it is listed.
 */
const CALLER_ROUTES = new Set(['GET /api/contacts', 'PUT /api/contacts/:id/lead', 'GET /api/leads/report']);

export const CALLER_REFUSED = 'Callers can only use the Leads page. Ask your admin for anything else.';

/** True when a caller may use this route (`url` is the route pattern that matched, never the raw URL). */
export function callerMayUse(method: string, url: string): boolean {
  return CALLER_ROUTES.has(`${method === 'HEAD' ? 'GET' : method} ${url}`);
}

export function isCaller(request: FastifyRequest): boolean {
  return request.auth?.user?.role === 'caller';
}

/** The user id whose leads a caller is limited to, or null when they see every lead (or aren't a caller). */
export function callerLeadOwner(request: FastifyRequest): number | null {
  const user = request.auth?.user;
  return user?.role === 'caller' && user.lead_scope !== 'all' ? user.id : null;
}
