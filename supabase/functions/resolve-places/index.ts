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

// @ts-expect-error
const GOOGLE_PLACES_API_KEY = Deno.env.get('GOOGLE_PLACES_API_KEY');
// @ts-expect-error
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// @ts-expect-error
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

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

  // home / residence
  if (/(apartment|home_goods|housing|residence)/.test(t)) return 'home';

  // food
  if (/(restaurant|cafe|coffee|bakery|bar|food|meal|fast_food|pub)/.test(t)) return 'food';

  // exercise
  if (/(gym|fitness|sports|stadium|swim|yoga)/.test(t)) return 'gym';

  // education
  if (/(school|university|college|library|study)/.test(t)) return 'education';

  // work
  if (/(office|coworking|corporate)/.test(t)) return 'work';

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

// ---------- Google Places (New) call ----------------------------------------

type PlacesHit = {
  id: string;
  displayName?: { text: string };
  primaryType?: string;
  types?: string[];
};

async function nearbySearch(
  lat: number,
  lon: number,
  radiusM = 100,
): Promise<PlacesHit | null> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY!,
      // Basic-tier field mask — keeps us on the cheaper SKU.
      'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.primaryType',
    },
    body: JSON.stringify({
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lon }, radius: radiusM },
      },
      maxResultCount: 5,
      rankPreference: 'DISTANCE',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Places ${res.status}: ${errText}`);
  }
  const data = (await res.json()) as { places?: PlacesHit[] };
  return data.places?.[0] ?? null;
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

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonRes({ error: 'Missing Authorization' }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return jsonRes({ error: 'Unauthorized' }, 401);
  const userId = userData.user.id;

  // Optional body: { place_ids?: string[] } — if present, only resolve those.
  let bodyIds: string[] | undefined;
  try {
    const body = await req.json();
    if (Array.isArray(body?.place_ids)) bodyIds = body.place_ids;
  } catch { /* empty body is fine */ }

  let q = supabase
    .from('places')
    .select('id, geohash_7, google_place_id')
    .eq('user_id', userId)
    .is('google_place_id', null);
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
      const { lat, lon } = decodeGeohash(p.geohash_7);
      const hit = await nearbySearch(lat, lon, 100);

      if (!hit) {
        results.push({ place_id: p.id, ok: true, name: undefined });
        // mark resolved-but-empty so we don't keep retrying — set a sentinel
        await supabase
          .from('places')
          .update({
            google_place_id: 'NO_MATCH',
            inference_status: 'pending',
            updated_at: new Date().toISOString(),
          })
          .eq('id', p.id);
        continue;
      }

      const name = hit.displayName?.text ?? null;
      const primaryType = hit.primaryType ?? null;
      const category = categorize(primaryType);
      const sensitive = isSensitive(primaryType, hit.types ?? []);

      const { error: updErr } = await supabase
        .from('places')
        .update({
          google_place_id: hit.id,
          name,
          primary_type: primaryType,
          category,
          is_sensitive: sensitive,
          updated_at: new Date().toISOString(),
        })
        .eq('id', p.id);

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
