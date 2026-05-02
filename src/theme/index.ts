/**
 * ALINE design system
 *
 * Dark, calm, premium. Anti-addictive: no bright reds, no urgent
 * notifications, no gamification colors. Suggestion accent is cool teal.
 */

export const colors = {
  // Surfaces
  bg: '#0A0E1A',          // app background
  bgElevated: '#111827',  // cards, inputs
  bgRaised: '#1A2235',    // modals, hovered cards
  border: '#1F2937',
  borderSubtle: '#161E2E',

  // Text
  text: '#E5E7EB',
  textMuted: '#9CA3AF',
  textDim: '#6B7280',
  textInverse: '#0A0E1A',

  // Brand
  accent: '#5EEAD4',       // teal — agent, suggestions, "coordinated"
  accentDim: '#0F2A2A',
  accent2: '#7C9EFF',      // indigo — secondary
  accent2Dim: '#1A2240',

  // Event type colors (mirrors prototype)
  eventFixed: '#F87171',      // red-ish — immutable obligations
  eventFlexible: '#34D399',   // green — movable blocks
  eventGoal: '#FBBF24',       // amber — goal work
  eventCoordinated: '#5EEAD4',// teal — multi-agent hangouts

  // Status
  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

export const font = {
  size: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 17,
    xl: 20,
    xxl: 26,
    xxxl: 34,
  },
  weight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
} as const;

export const theme = { colors, space, radius, font } as const;
export type Theme = typeof theme;
