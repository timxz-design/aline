/**
 * Static data for the onboarding flow. Living here so the UI screens stay
 * declarative.
 *
 * Shape note: each interest tile maps to a row in `interests` with key set
 * to the `category` and value set to `{ label, icon, source: 'onboarding' }`.
 * That way the agent's prompt builder can read interests uniformly without
 * caring about how they were collected.
 */

export type InterestTile = {
  /** Stable key — also the `interests.key` for rows created from this tile. */
  category: string;
  label: string;
  icon: string;
  /** A short blurb the agent can use as context when reasoning. */
  blurb?: string;
};

export const INTEREST_TILES: InterestTile[] = [
  { category: 'activity_like', label: 'Active / fitness', icon: '🏃', blurb: 'gym, running, sports' },
  { category: 'activity_like', label: 'Outdoors', icon: '🥾', blurb: 'hiking, biking, nature' },
  { category: 'activity_like', label: 'Food / cooking', icon: '🍳', blurb: 'cooking, eating out, trying restaurants' },
  { category: 'activity_like', label: 'Coffee / chill hangs', icon: '☕', blurb: 'cafés, low-key catchups' },
  { category: 'activity_like', label: 'Going out', icon: '🍻', blurb: 'bars, parties, nightlife' },
  { category: 'activity_like', label: 'Music / creative', icon: '🎸', blurb: 'making or listening to music, art' },
  { category: 'activity_like', label: 'Film / shows', icon: '🎬', blurb: 'movies, series, watching together' },
  { category: 'activity_like', label: 'Gaming', icon: '🎮', blurb: 'video games, board games' },
  { category: 'activity_like', label: 'Study / learning', icon: '📚', blurb: 'study groups, lectures, courses' },
  { category: 'activity_like', label: 'Travel / exploring', icon: '🌍', blurb: 'trips, day trips, exploring city' },
  { category: 'activity_like', label: 'Wellness', icon: '🧘', blurb: 'yoga, meditation, mental health' },
  { category: 'activity_like', label: 'Career / networking', icon: '💼', blurb: 'professional events, side projects' },
];

export type SocialOpenness = 'closed' | 'crew_only' | 'open';

export const OPENNESS_OPTIONS: Array<{
  value: SocialOpenness;
  label: string;
  /** Compact form for a settings row value. */
  short: string;
  description: string;
}> = [
  {
    value: 'closed',
    label: 'Just me right now',
    short: 'Just me',
    description: "I'll add my own crew. Don't suggest anyone new.",
  },
  {
    value: 'crew_only',
    label: 'Coordinate with my crew',
    short: 'My crew',
    description: 'Help me hang out with people I add. Suggestions later, not now.',
  },
  {
    value: 'open',
    label: 'Open to meeting people',
    short: 'Open',
    description:
      'When ALINE finds compatible people in my circle, surface them.',
  },
];
