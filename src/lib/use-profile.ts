import { useEffect, useState } from 'react';
import type { Profile } from '../types/database';
import { useAuth } from './auth-context';
import { supabase } from './supabase';

/**
 * Loads the current user's `profiles` row and keeps it in sync.
 *
 * Returns:
 *   - profile: the row, or null while loading / signed-out
 *   - loading: true on initial fetch
 *   - refresh: re-fetch (call after onboarding writes, name edits, etc.)
 *
 * The auth-context's `user.id` triggers the load. RLS makes sure callers
 * can only read their own profile.
 */
export function useProfile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async (userId: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      console.warn('Profile load failed:', error.message);
    }
    setProfile(data ?? null);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) {
      setProfile(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    load(user.id);
  }, [user?.id]);

  return {
    profile,
    loading,
    refresh: () => (user ? load(user.id) : Promise.resolve()),
  };
}
