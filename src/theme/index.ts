/**
 * ALINE design system — "warm paper" light theme, derived from the logo:
 * off-white with a hint of brown, deep teal as the working accent, mint for
 * washes, periwinkle as the secondary. Calm, anti-addictive: no bright reds,
 * no urgent notification colors, no gamification.
 */

export const colors = {
  // Surfaces — warm paper; cards separate by tone (white on cream), not borders
  bg: '#F5F1EA',          // app background — off-white, hint of brown
  bgElevated: '#FFFFFF',  // cards
  bgRaised: '#EDE7DC',    // chips, inputs, nested surfaces
  border: '#E2DACB',
  borderSubtle: '#ECE6DA',

  // Text — deep teal-charcoal from the wordmark
  text: '#1C3A3B',
  textMuted: '#5D6E6C',
  textDim: '#93A09D',
  textInverse: '#FFFFFF',

  // Brand — from the logo mark
  accent: '#2E7D78',       // deep teal — agent, actions, "coordinated"
  accentDim: '#DFEDE8',    // mint wash — fills, selected states
  accent2: '#6C8CE8',      // periwinkle — secondary
  accent2Dim: '#E6EBFB',

  // Event type colors (deepened for light surfaces)
  eventFixed: '#D4574E',      // warm red — immutable obligations
  eventFlexible: '#2E9E6B',   // green — movable blocks
  eventGoal: '#C98A00',       // amber — goal work
  eventCoordinated: '#2E7D78',// teal — multi-agent hangouts

  // Status
  success: '#2E9E6B',
  warning: '#C98A00',
  danger: '#D4574E',
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
