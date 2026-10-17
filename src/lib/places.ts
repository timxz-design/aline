/**
 * Places on the phone: only the Google identity lookup is still triggered
 * from here. Building places happens on the server (see below).
 */

import { supabase } from './supabase';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

/**
 * Places are built on the server now (`rebuild_places`, hourly) from the
 * stays timeline — repeated real stays, merged within 150 m, typed by pattern.
 * The phone no longer clusters raw pings (that produced a place for every
 * slow walk and brief stop). Kept as a no-op so the pipeline shape is intact.
 */
export async function recomputePlacesForCurrentUser(): Promise<{
  pingsRead: number;
  clustersFound: number;
  placesUpserted: number;
  newPlacesCreated: number;
  error?: string;
}> {
  return { pingsRead: 0, clustersFound: 0, placesUpserted: 0, newPlacesCreated: 0 };
}

/**
 * Call the `resolve-places` Edge Function to label any unresolved places
 * with Google Places identity (name, type, category, sensitive flag).
 */
export async function resolvePlaceIdentities(): Promise<{
  resolved: number;
  total: number;
  error?: string;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { resolved: 0, total: 0, error: 'not signed in' };

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/resolve-places`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    if (!res.ok) return { resolved: 0, total: 0, error: body?.error ?? `HTTP ${res.status}` };
    return { resolved: body.resolved ?? 0, total: body.total ?? 0 };
  } catch (e) {
    return {
      resolved: 0,
      total: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
