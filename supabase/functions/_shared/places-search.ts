/**
 * Venue search (Layer B, solo first) — find candidate venues for an activity
 * near a point, with the signals needed to rank them (rating, price, open-now).
 *
 * Provider: Google Places Nearby Search (New). Uses GOOGLE_PLACES_API_KEY
 * (the same key, which must also allow Places). Field mask includes rating /
 * priceLevel / openNow (Places "Pro" tier) — fine at test volume; cache later.
 *
 * NOTE: no long-term storage of rating/reviews (Places licensing). Caller may
 * cache place_id only.
 */

// @ts-nocheck Deno edge runtime
const PLACES_KEY = Deno.env.get('GOOGLE_PLACES_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_API_KEY');

export function placesConfigured(): boolean {
  return !!PLACES_KEY;
}

export type VenueCandidate = {
  placeId: string;
  name: string | null;
  primaryType: string | null;
  category: string;       // coarse bucket (food/gym/...) for preference matching
  lat: number;
  lon: number;
  rating: number | null;
  reviews: number | null;
  priceLevel: number | null;   // 0..4 (Google PRICE_LEVEL_* → int)
  openNow: boolean | null;
};

/** Map a free-text activity to Google place types for Nearby Search. */
export function activityToTypes(activity: string): string[] {
  const a = activity.toLowerCase();
  if (/(coffee|café|cafe|espresso)/.test(a)) return ['cafe', 'coffee_shop'];
  if (/(breakfast|brunch)/.test(a)) return ['breakfast_restaurant', 'cafe'];
  if (/(lunch|dinner|eat|meal|food|restaurant|dine)/.test(a)) return ['restaurant'];
  if (/(drink|beer|wine|cocktail|bar|pub|nightlife)/.test(a)) return ['bar'];
  if (/(dessert|cake|ice cream|sweet)/.test(a)) return ['dessert_shop', 'cafe', 'bakery'];
  if (/(gym|workout|fitness|train)/.test(a)) return ['gym', 'fitness_center'];
  // default: somewhere to sit and meet
  return ['cafe', 'restaurant'];
}

/** Coarse category from primaryType (subset; mirrors resolve-places, no home/work). */
function coarseCategory(primaryType: string | null): string {
  if (!primaryType) return 'other';
  const t = primaryType.toLowerCase();
  if (/(restaurant|cafe|coffee|bakery|bar|food|meal|fast_food|pub)/.test(t)) return 'food';
  if (/(gym|fitness|sports|stadium|swim|yoga)/.test(t)) return 'gym';
  if (/(store|shop|market|grocery|supermarket|mall|department)/.test(t)) return 'shopping';
  if (/(park|garden|trail|beach|forest)/.test(t)) return 'outdoors';
  if (/(night_club|movie_theater|theater|museum|art_gallery)/.test(t)) return 'social';
  return 'other';
}

const PRICE_MAP: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

type RawPlace = {
  id: string;
  displayName?: { text: string };
  primaryType?: string;
  types?: string[];
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  currentOpeningHours?: { openNow?: boolean };
};

export async function searchVenues(opts: {
  lat: number;
  lon: number;
  includedTypes: string[];
  radiusM?: number;
  maxResults?: number;
  rankPreference?: 'POPULARITY' | 'DISTANCE';
}): Promise<VenueCandidate[]> {
  if (!PLACES_KEY) throw new Error('places_not_configured');

  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.types,places.primaryType,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours.openNow',
    },
    body: JSON.stringify({
      includedTypes: opts.includedTypes,
      locationRestriction: {
        circle: { center: { latitude: opts.lat, longitude: opts.lon }, radius: opts.radiusM ?? 4000 },
      },
      maxResultCount: opts.maxResults ?? 15,
      rankPreference: opts.rankPreference ?? 'POPULARITY',
    }),
  });
  if (!res.ok) throw new Error(`places_search_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { places?: RawPlace[] };

  return (data.places ?? [])
    .filter((p) => p.location)
    .map((p) => ({
      placeId: p.id,
      name: p.displayName?.text ?? null,
      primaryType: p.primaryType ?? null,
      category: coarseCategory(p.primaryType ?? null),
      lat: p.location!.latitude,
      lon: p.location!.longitude,
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviews: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      priceLevel: p.priceLevel ? (PRICE_MAP[p.priceLevel] ?? null) : null,
      openNow: p.currentOpeningHours?.openNow ?? null,
    }));
}

/** Resolve a free-text venue name/address to one place (Text Search, best hit).
 *  Used to geocode event venues at save time. `biasLat/Lon` (e.g. the user's
 *  origin) keeps "Kino" from resolving to the wrong town. Returns null when
 *  nothing sensible matches — the caller keeps the free text and moves on. */
export async function searchPlaceByText(opts: {
  query: string;
  biasLat?: number;
  biasLon?: number;
}): Promise<{ placeId: string; name: string | null; address: string | null; lat: number; lon: number; category: string } | null> {
  if (!PLACES_KEY) throw new Error('places_not_configured');

  const body: Record<string, unknown> = { textQuery: opts.query, maxResultCount: 1 };
  if (opts.biasLat != null && opts.biasLon != null) {
    body.locationBias = {
      circle: { center: { latitude: opts.biasLat, longitude: opts.biasLon }, radius: 30000 },
    };
  }
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.primaryType,places.location,places.formattedAddress',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`places_text_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { places?: (RawPlace & { formattedAddress?: string })[] };
  const p = (data.places ?? []).find((x) => x.location);
  if (!p) return null;
  return {
    placeId: p.id,
    name: p.displayName?.text ?? null,
    address: p.formattedAddress ?? null,
    lat: p.location!.latitude,
    lon: p.location!.longitude,
    category: coarseCategory(p.primaryType ?? null),
  };
}
