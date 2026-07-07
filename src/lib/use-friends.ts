import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth-context';
import { supabase } from './supabase';

export type FriendProfile = {
  id: string;
  handle: string | null;
  first_name: string | null;
  display_name: string | null;
  /** The tier the CURRENT user grants this friend ('inner' = full sharing). */
  myTier: 'friend' | 'inner';
};

/** Set the current user's trust tier toward a friend. */
export async function setFriendTier(
  otherUserId: string,
  tier: 'friend' | 'inner',
): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('set_friend_tier', { _other_user: otherUserId, _tier: tier });
  return error ? { error: error.message } : {};
}

export type PendingRequest = {
  /** The other user's profile (the one who sent the request to me, OR I sent it to). */
  user: FriendProfile;
  /** Whether *I* sent this request (true) or received it (false). */
  outbound: boolean;
};

type Result = {
  friends: FriendProfile[];
  pending: PendingRequest[];
  loading: boolean;
  refresh: () => Promise<void>;
};

/**
 * Loads the current user's friend graph.
 *
 *   - friends:  accepted relationships
 *   - pending:  pending requests, separated into inbound (act on) vs outbound (sent)
 *
 * Uses a single `friendships` query, then resolves the "other" side via a
 * separate `profiles` lookup so we don't depend on PostgREST embedded selects
 * (which the existing schema isn't set up for here).
 */
export function useFriends(): Result {
  const { user } = useAuth();
  const [friends, setFriends] = useState<FriendProfile[]>([]);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) {
      setFriends([]);
      setPending([]);
      setLoading(false);
      return;
    }
    setLoading(true);

    const { data: rows, error } = await supabase
      .from('friendships')
      .select('user_a, user_b, status, requested_by, updated_at, tier_a, tier_b')
      .or(`user_a.eq.${user.id},user_b.eq.${user.id}`);

    if (error) {
      console.warn('Friendships load failed:', error.message);
      setFriends([]);
      setPending([]);
      setLoading(false);
      return;
    }

    const otherIds = new Set<string>();
    for (const r of rows ?? []) {
      otherIds.add(r.user_a === user.id ? r.user_b : r.user_a);
    }

    type BaseProfile = Omit<FriendProfile, 'myTier'>;
    let profilesById = new Map<string, BaseProfile>();
    if (otherIds.size > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, handle, first_name, display_name')
        .in('id', Array.from(otherIds));
      profilesById = new Map((profs ?? []).map((p) => [p.id, p as BaseProfile]));
    }

    const fr: FriendProfile[] = [];
    const pen: PendingRequest[] = [];
    for (const r of rows ?? []) {
      const otherId = r.user_a === user.id ? r.user_b : r.user_a;
      const profile = profilesById.get(otherId);
      if (!profile) continue;
      if (r.status === 'accepted') {
        const rawTier = r.user_a === user.id ? r.tier_a : r.tier_b;
        fr.push({ ...profile, myTier: rawTier === 'inner' ? 'inner' : 'friend' });
      } else if (r.status === 'pending') {
        pen.push({ user: { ...profile, myTier: 'friend' }, outbound: r.requested_by === user.id });
      }
    }
    fr.sort((a, b) =>
      (a.first_name ?? a.handle ?? '').localeCompare(b.first_name ?? b.handle ?? '')
    );
    setFriends(fr);
    setPending(pen);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep a stable ref to the latest `load` so the realtime effect doesn't
  // need to re-subscribe whenever `load` is recreated.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // Realtime: any friendship change involving this user → reload.
  // Subscribe ONCE per user.id. Channel name includes a per-instance suffix
  // so racing cleanup/setup never collides on a reused channel name (which
  // would throw "cannot add postgres_changes callbacks after subscribe()").
  useEffect(() => {
    if (!user?.id) return;
    const channel = supabase
      .channel(`friendships-${user.id}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friendships' },
        () => {
          loadRef.current?.();
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  return { friends, pending, loading, refresh: load };
}
