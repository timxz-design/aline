/**
 * resolve-places — Supabase Edge Function
 * ----------------------------------------------------------------------------
 * Takes the authenticated user's clustered places (rows in `places` where
 * `google_place_id IS NULL`), looks each one up via Google Places Nearby
 * Search, and writes back identity (name, primary_type, category) plus the
 * `is_sensitive` flag for medical / religious / legal venues.
 *
 * Cost note: Google Places Nearby Search (New) is $0.032 per call (Basic tier
 * with the field mask we use). Run sparingly — the result is cached forever
 * in `places.google_place_id`, so a place is only ever resolved once.
 *
 * Sensitive-type policy (Stranger Data Firewall, Block 2 prerequisite):
 *   Medical, mental-health, addiction, religious, legal, and funeral venues
 *   get is_sensitive=true. They remain visible to the user in their own
 *   profile, but Block 2's RLS view will exclude them from any query that
 *   strangers can make.
 *
 * Secrets required:
 *   - GOOGLE_PLACES_API_KEY    (Places API enabled, key restricted to Places)
 * ----------------------------------------------------------------------------
 */

// @ts-expect-error — Deno-only deps; this file runs in Supabase Edge Runtime.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { rankPlacesForStay } from '../_shared/place-rank.ts';

// @ts-expect-error
const GOOGLE_PLACES_API_KEY = Deno.env.get('GOOGLE_PLACES_API_KEY');
// @ts-expect-error
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// @ts-expect-error
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// @ts-expect-error
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// @ts-expect-error
const CRON_SECRET = Deno.env.get('CRON_SECRET');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------- geohash decoder (Deno-side copy; pure, no deps) -----------------

const GH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function decodeGeohash(hash: string): { lat: number; lon: number } {
  let evenBit = true;
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  for (let i = 0; i < hash.length; i++) {
    const idx = GH_BASE32.indexOf(hash[i]);
    if (idx < 0) throw new Error(`Invalid geohash char: ${hash[i]}`);
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (bit === 1) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit === 1) latMin = mid; else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

// ---------- type classification --------------------------------------------

/**
 * Map Google's fine-grained primary_type to one of our broader categories.
 * Categories are stable across Places API versions; primary_type isn't.
 */
function categorize(primaryType: string | null): string {
  if (!primaryType) return 'other';
  const t = primaryType.toLowerCase();

  // NOTE: 'home' and 'work' are NEVER assigned from a Google venue type. They
  // are behavioral identities ("where YOU sleep / work"), set only by
  // inferPlaceLabel's time-of-day pattern (overnight presence; recurring
  // weekday business-hours dwell). A residence or corporate office that Google
  // happens to find near a drive-by must not become the user's home/work.
  // Home-goods stores fall through to 'shopping' (they contain 'store');
  // residences/offices fall through to 'other'.

  // food
  if (/(restaurant|cafe|coffee|bakery|bar|food|meal|fast_food|pub)/.test(t)) return 'food';

  // exercise
  if (/(gym|fitness|sports|stadium|swim|yoga)/.test(t)) return 'gym';

  // education
  if (/(school|university|college|library|study)/.test(t)) return 'education';

  // shopping
  if (/(store|shop|market|grocery|supermarket|mall|department)/.test(t)) return 'shopping';

  // transit
  if (/(transit|train|bus|airport|subway|station|parking)/.test(t)) return 'transit';

  // outdoors
  if (/(park|garden|trail|beach|forest)/.test(t)) return 'outdoors';

  // social / nightlife
  if (/(night_club|movie_theater|theater|museum|art_gallery|tourist_attraction)/.test(t)) return 'social';

  // sensitive (also flagged below)
  if (/(hospital|doctor|dentist|pharmacy|physiotherapist|medical|wellness|veterinary)/.test(t)) return 'health';
  if (/(church|mosque|synagogue|temple|place_of_worship)/.test(t)) return 'religion';
  if (/(lawyer|courthouse|legal)/.test(t)) return 'legal';
  if (/(funeral|cemetery)/.test(t)) return 'funeral';

  return 'other';
}

const SENSITIVE_PATTERNS = [
  /hospital/,
  /doctor/,
  /dentist/,
  /pharmacy/,
  /physiotherapist/,
  /medical_lab/,
  /wellness_center/,
  /veterinary/,
  /addiction_treatment/,
  /mental_health/,
  /rehabilitation/,
  /church/,
  /mosque/,
  /synagogue/,
  /temple/,
  /place_of_worship/,
  /funeral/,
  /cemetery/,
  /lawyer/,
  /courthouse/,
];

function isSensitive(primaryType: string | null, allTypes: string[] = []): boolean {
  const haystack = [primaryType ?? '', ...allTypes].join(' ').toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => p.test(haystack));
}

// ---------- Google Places (New) — ranking lives in _shared/place-rank.ts ----

// Non-activity infrastructure we never want to label a person's visit as.
// Excluded at the API level so they don't even count toward maxResultCount.
const EXCLUDED_TYPES = [
  'parking',
  'bus_stop',
  'bus_station',
  'transit_station',
  'train_station',
  'subway_station',
  'light_rail_station',
  'transit_depot',
];

// Primary types that are landmarks / generic / non-activity — we'd rather
// return NO_MATCH than label a person's visit as one of these. A named tree
// ("Drevo Tulipovac") shows up as tourist_attraction / natural_feature; a
// bare point_of_interest tells us nothing about what the person was doing.
const GENERIC_PRIMARY_REJECT = new Set([
  'tourist_attraction',
  'natural_feature',
  'point_of_interest',
  'premise',
  'route',
  'street_address',
  'plus_code',
  'locality',
  'political',
  'establishment',
]);

/** First ranked candidate that isn't infrastructure or a generic landmark. */
function pickRanked(ranked: Awaited<ReturnType<typeof rankPlacesForStay>>) {
  for (const c of ranked) {
    const primary = (c.primaryType ?? '').toLowerCase();
    const allTypes = c.types.map((t) => t.toLowerCase());
    if (EXCLUDED_TYPES.some((b) => primary === b || allTypes.includes(b))) continue;
    if (!primary || GENERIC_PRIMARY_REJECT.has(primary)) continue;
    if (c.score <= 0) continue;
    return c;
  }
  return null;
}

// ---------- handler ---------------------------------------------------------

// @ts-expect-error
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonRes({ error: 'POST required' }, 405);

  if (!GOOGLE_PLACES_API_KEY) {
    return jsonRes(
      { error: 'GOOGLE_PLACES_API_KEY not configured. Set it in Supabase secrets.' },
      500,
    );
  }

  // Places are server-owned now (users can only edit label/category/hidden),
  // so identity writes go through the service role — always scoped to the
  // place's own user.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Two callers: the hourly cron (x-cron-key) names every user's unnamed
  // places — so testers who rarely open the app still get names — and the
  // app (user JWT) for that user's places only.
  const isCron = !!CRON_SECRET && req.headers.get('x-cron-key') === CRON_SECRET;
  let userId: string | null = null;
  if (!isCron) {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonRes({ error: 'Missing Authorization' }, 401);
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return jsonRes({ error: 'Unauthorized' }, 401);
    userId = userData.user.id;
  }

  // Optional body: { place_ids?: string[] } — if present, only resolve those.
  let bodyIds: string[] | undefined;
  try {
    const body = await req.json();
    if (Array.isArray(body?.place_ids)) bodyIds = body.place_ids;
  } catch { /* empty body is fine */ }

  let q = admin
    .from('places')
    .select('id, user_id, geohash_7, centroid_lat, centroid_lon, google_place_id, name, category, inference_status, user_label, visit_count, total_dwell_minutes')
    .is('google_place_id', null)
    .limit(40);
  if (userId) q = q.eq('user_id', userId);
  if (bodyIds && bodyIds.length > 0) q = q.in('id', bodyIds);

  const { data: places, error: fetchErr } = await q;
  if (fetchErr) return jsonRes({ error: fetchErr.message }, 500);
  if (!places || places.length === 0) {
    return jsonRes({ resolved: 0, total: 0, results: [] });
  }

  const results: Array<{
    place_id: string;
    ok: boolean;
    name?: string;
    primary_type?: string;
    category?: string;
    is_sensitive?: boolean;
    error?: string;
  }> = [];

  for (const p of places) {
    try {
      // Prefer the precise cluster centroid; fall back to the (imprecise)
      // geohash_7 cell center only for legacy rows that predate centroid cols.
      const lat = typeof p.centroid_lat === 'number'
        ? p.centroid_lat
        : decodeGeohash(p.geohash_7).lat;
      const lon = typeof p.centroid_lon === 'number'
        ? p.centroid_lon
        : decodeGeohash(p.geohash_7).lon;

      // Stay-aware ranking (destination you'd spend this long at, well known,
      // close) instead of "nearest POI" — nearest-first is what named places
      // after ATMs and parking lots. Same junk filters still apply.
      const minutesPerVisit = (p.total_dwell_minutes ?? 0) / Math.max(1, p.visit_count ?? 1);
      const ranked = await rankPlacesForStay(lat, lon, minutesPerVisit, 100);
      const hit = pickRanked(ranked);

      if (!hit) {
        results.push({ place_id: p.id, ok: true, name: undefined });
        // mark resolved-but-empty so we don't keep retrying — set a sentinel
        await admin
          .from('places')
          .update({
            google_place_id: 'NO_MATCH',
            inference_status: 'pending',
            updated_at: new Date().toISOString(),
          })
          .eq('id', p.id)
          .eq('user_id', p.user_id);
        continue;
      }

      const name = hit.name ?? null;
      const primaryType = hit.primaryType ?? null;
      // Defense-in-depth: behavioral categories are never sourced from Google.
      // categorize() no longer returns these, but clamp anyway so a future
      // regression can't reintroduce "drive-by office → work".
      let category = categorize(primaryType);
      if (category === 'home' || category === 'work') category = 'other';
      const sensitive = isSensitive(primaryType, hit.types ?? []);

      // Preserve Home / Work labels from time-of-day inference, and any
      // label the user has corrected. Google still gets to flag is_sensitive
      // and we record the google_place_id so we don't re-query, but we don't
      // clobber the meaningful label.
      const isUserCorrected = p.inference_status === 'corrected' || p.user_label != null;
      const isStrongTimeLabel = p.category === 'home' || p.category === 'work';
      const preserveLabel = isUserCorrected || isStrongTimeLabel;

      const updatePayload: Record<string, unknown> = {
        google_place_id: hit.googleId,
        is_sensitive: sensitive,
        updated_at: new Date().toISOString(),
      };
      if (!preserveLabel) {
        updatePayload.name = name;
        updatePayload.primary_type = primaryType;
        updatePayload.category = category;
      }

      const { error: updErr } = await admin
        .from('places')
        .update(updatePayload)
        .eq('id', p.id)
        .eq('user_id', p.user_id);

      if (updErr) {
        results.push({ place_id: p.id, ok: false, error: updErr.message });
      } else {
        results.push({
          place_id: p.id,
          ok: true,
          name: name ?? undefined,
          primary_type: primaryType ?? undefined,
          category,
          is_sensitive: sensitive,
        });
      }
    } catch (e) {
      results.push({
        place_id: p.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return jsonRes({
    resolved: results.filter((r) => r.ok).length,
    total: places.length,
    results,
  });
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
