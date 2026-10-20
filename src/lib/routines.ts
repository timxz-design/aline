/**
 * Routines are built on the server now (`rebuild_routines`, hourly) from the
 * stays timeline, including recurring walks/runs/rides. No-op on the phone.
 */
export async function recomputeRoutinesForCurrentUser(): Promise<{
  pingsRead: number;
  placesRead: number;
  routinesFound: number;
  error?: string;
}> {
  return { pingsRead: 0, placesRead: 0, routinesFound: 0 };
}
