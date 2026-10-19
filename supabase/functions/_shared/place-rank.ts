// @ts-nocheck Deno edge runtime
/**
 * Stay-aware place lookup (Google Places API (New), searchNearby).
 *
 * "Nearest POI" is the wrong question for a stay: next to any faculty there's
 * an ATM, a parking lot and a student society at 30 m. For a stay of N minutes
 * we want the DESTINATION — a school, office, gym, shop, café — that's well
 * known and close. Verified on a real stop: nearest-first picked a research
 * institute inside the building; this ranking picked "School of Economics and
 * Business, University of Ljubljana".
 */

const KEY = Deno.env.get('GOOGLE_PLACES_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_API_KEY');

export type PlaceCandidate = {
  googleId: string;
  name: string;
  primaryType: string | null;
  types: string[];
  metres: number;
  ratings: number;
  score: number;
};

function metres(a: number, b: number, c: number, d: number): number {
  const R = 6371000, r = Math.PI / 180;
  const x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
  return Math.round(Math.sqrt(x * x + y * y) * R);
}

// Never where someone "was" for a stay.
const NOT_DESTINATION = /^(atm|parking|parking_lot|bus_stop|transit_station|train_station|route|street_address|premise|plus_code|locality|political|sublocality|neighborhood|electric_vehicle_charging_station|gas_station)$/;
const DESTINATION = /university|school|college|library|hospital|doctor|dentist|clinic|gym|fitness|office|corporate|government|store|shop|supermarket|market|cafe|coffee|restaurant|bar|bakery|hair|barber|beauty|spa|church|museum|stadium|sports|park|cinema|theater/;
const LONG_STAY = /university|school|college|office|hospital|gym|fitness|library|corporate|government/;

export function placesConfigured(): boolean {
  return !!KEY;
}

/** Ranked candidates for a stay of `minutes` at lat/lon. Best first. */
export async function rankPlacesForStay(lat: number, lon: number, minutes: number, radius = 120): Promise<PlaceCandidate[]> {
  if (!KEY) throw new Error('places_not_configured');
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.primaryType,places.types,places.location,places.userRatingCount',
    },
    body: JSON.stringify({
      maxResultCount: 20,
      rankPreference: 'POPULARITY',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } },
    }),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`places_${res.status}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);

  return (j.places ?? [])
    .map((p) => {
      const types: string[] = p.types ?? [];
      const primary: string | null = p.primaryType ?? null;
      const m = metres(lat, lon, p.location.latitude, p.location.longitude);
      const ratings = p.userRatingCount ?? 0;
      const all = [primary ?? '', ...types].join(',');
      let s = 0;
      if (primary && NOT_DESTINATION.test(primary)) s -= 60;
      if (DESTINATION.test(all)) s += 30;
      if (minutes >= 30 && LONG_STAY.test(all)) s += 20;
      s += Math.min(25, Math.log10(1 + ratings) * 10); // well-known places
      s -= m / 4; // closer is better, softly
      return { googleId: p.id, name: p.displayName?.text ?? '', primaryType: primary, types, metres: m, ratings, score: Math.round(s) };
    })
    .filter((c) => c.name)
    .sort((a, b) => b.score - a.score);
}

// Landmarks / generic entries tell us nothing about what someone was doing.
const GENERIC = new Set(['tourist_attraction', 'natural_feature', 'point_of_interest', 'premise', 'route',
  'street_address', 'plus_code', 'locality', 'political', 'establishment']);

/** The best plausible destination, or null (a no-match beats a false match). */
export function bestForStay(cands: PlaceCandidate[]): PlaceCandidate | null {
  for (const c of cands) {
    const primary = (c.primaryType ?? '').toLowerCase();
    if (!primary || GENERIC.has(primary) || NOT_DESTINATION.test(primary)) continue;
    if (c.score <= 0) continue;
    return c;
  }
  return null;
}
