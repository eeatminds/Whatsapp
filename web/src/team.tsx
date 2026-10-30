import { useApi, type Me, type TeamMember } from './api';

/** Callers only work the Leads page; everything else in the app is hidden from them (and refused by the server). */
export const isCaller = (me: Me): boolean => me.user?.role === 'caller';

export const memberName = (m: Pick<TeamMember, 'name' | 'email'>): string => m.name?.trim() || m.email;

/** People who can be given leads: callers first, then the rest of the team. */
export function useTeam(enabled = true) {
  const { data } = useApi<{ items: TeamMember[] }>(enabled ? '/api/team' : null);
  const items = [...(data?.items ?? [])].sort((a, b) => Number(b.role === 'caller') - Number(a.role === 'caller') || memberName(a).localeCompare(memberName(b)));
  return { team: items, loaded: !!data, byId: new Map(items.map(m => [m.id, m])) };
}

/** "Ramgopal (Caller)". */
export function memberLabel(m: TeamMember): string {
  return m.role === 'caller' ? memberName(m) : `${memberName(m)} (${m.role === 'owner' ? 'Admin' : 'Team member'})`;
}
