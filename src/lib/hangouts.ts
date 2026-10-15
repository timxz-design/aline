/**
 * Plan (hangout) data for the plan sheet and calendar colouring. All reads go
 * through SECURITY DEFINER RPCs that check the caller is in the plan, so
 * participants who aren't each other's friends still see names.
 */

import { supabase } from './supabase';

export type InvitePolicy = 'host_only' | 'participants' | 'mutuals';
export type ParticipantStatus = 'confirmed' | 'maybe' | 'pending' | 'declined';

export type Participant = {
  user_id: string;
  status: ParticipantStatus;
  first_name: string | null;
  display_name?: string | null;
  handle: string | null;
};

export type HangoutDetails = {
  id: string;
  title: string | null;
  description: string | null;
  reasoning: string | null;
  status: 'proposing' | 'confirmed' | 'cancelled' | string;
  proposed_start: string | null;
  proposed_end: string | null;
  venue_name: string | null;
  venue_address: string | null;
  venue_lat: number | null;
  venue_lng: number | null;
  min_attendees: number | null;
  group_id: string | null;
  group_name: string | null;
  proposed_by: string;
  invite_policy: InvitePolicy;
  is_host: boolean;
  can_invite: boolean;
  participants: Participant[];
};

export type InviteCandidate = {
  user_id: string;
  first_name: string | null;
  handle: string | null;
  allowed: boolean;
  reason: 'already_in' | 'not_your_friend' | 'no_mutual' | null;
};

export const INVITE_POLICY_LABEL: Record<InvitePolicy, string> = {
  host_only: 'Only me',
  participants: 'Anyone going',
  mutuals: 'Mutual friends',
};

export function personName(p: { first_name?: string | null; display_name?: string | null; handle?: string | null }): string {
  return p.first_name || p.display_name || (p.handle ? `@${p.handle}` : 'Someone');
}

export async function getHangoutDetails(id: string): Promise<HangoutDetails | null> {
  const { data, error } = await supabase.rpc('get_hangout_details', { _hangout_id: id });
  if (error) throw new Error(error.message);
  return (data as HangoutDetails | null) ?? null;
}

export async function getInviteCandidates(id: string): Promise<InviteCandidate[]> {
  const { data, error } = await supabase.rpc('hangout_invite_candidates', { _hangout_id: id });
  if (error) throw new Error(error.message);
  return (data ?? []) as InviteCandidate[];
}

export async function inviteToHangout(id: string, userIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('invite_to_hangout', { _hangout_id: id, _user_ids: userIds });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

export async function setInvitePolicy(id: string, policy: InvitePolicy): Promise<void> {
  const { error } = await supabase.rpc('set_hangout_invite_policy', { _hangout_id: id, _policy: policy });
  if (error) throw new Error(error.message);
}

export async function respondToHangout(id: string, status: 'confirmed' | 'maybe' | 'declined'): Promise<void> {
  const { error } = await supabase.rpc('respond_to_hangout', { _hangout_id: id, _status: status });
  if (error) throw new Error(error.message);
}

/** hangout_id → participants, for colouring many calendar blocks in one call. */
export async function getParticipantsFor(ids: string[]): Promise<Map<string, Participant[]>> {
  const out = new Map<string, Participant[]>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase.rpc('hangout_participants_for', { _hangout_ids: ids });
  if (error) {
    console.warn('[hangouts] participants lookup failed:', error.message);
    return out;
  }
  for (const r of (data ?? []) as (Participant & { hangout_id: string })[]) {
    const list = out.get(r.hangout_id) ?? [];
    list.push(r);
    out.set(r.hangout_id, list);
  }
  return out;
}
