/**
 * Heritage Hero palette — ported from the approved design direction
 * (design exploration frame D). Cream paper surfaces, cobalt primaries,
 * and orange reserved strictly for accents. Soft radius (9 cards / 7
 * controls) replaces the old square Cobalt Ledger geometry.
 *
 * Token NAMES are kept from the Cobalt Ledger era so existing screens
 * keep compiling; only the values moved to Heritage.
 */

const colors = {
  light: {
    // Legacy aliases
    text: '#26364b',
    tint: '#315eae',

    // Core surfaces
    background: '#f2f3f4',
    foreground: '#26364b',

    // Cards / elevated surfaces
    card: '#fdfcf9',
    cardForeground: '#26364b',

    // Primary action (cobalt blue)
    primary: '#315eae',
    primaryForeground: '#ffffff',

    // Secondary surfaces
    secondary: '#f5f7f9',
    secondaryForeground: '#26364b',

    // Muted / subdued
    muted: '#eaedef',
    mutedForeground: '#7e8994',

    // Accent highlights (pale cobalt chip surface)
    accent: '#e3ecf7',
    accentForeground: '#26364b',

    // Destructive
    destructive: '#a04646',
    destructiveForeground: '#ffffff',

    // Borders and inputs (hairlines)
    border: '#d8e0e9',
    input: '#d8e0e9',

    // Extended tokens (Heritage values under Ledger-era names)
    navy: '#203b64',
    navyLight: '#243f66',
    cobalt: '#315eae',
    cobaltLight: '#5878b9',
    cobaltMuted: '#9db1d4',
    paperBg: '#f2f3f4',
    paperCard: '#fdfcf9',
    paperCardAlt: '#f9faf8',
    sidebarBg: '#e5edf7',
    divider: '#e8e8e5',
    labelText: '#7e8994',
    bodyText: '#56708e',
    subtleText: '#858d95',
    // Status
    activeGreen: '#315eae',
    activeBg: '#e9f1fa',
    activeBorder: '#b7cbe8',
    warnText: '#b65c22',
    warnBg: '#fff4e6',
    warnBorder: '#e8b47c',
    riskText: '#a04646',
    riskBg: '#fff0f0',
    riskBorder: '#d5a7a7',
    // Heritage accent (use sparingly: streak marks, fat macro, small icons,
    // active-tab tick — never large surfaces)
    orange: '#df772c',
    orangeText: '#b65c22',
    orangeBg: '#fff4e6',
    orangeBorder: '#e8b47c',
    // Neutral progress-bar track
    track: '#e5e8eb',
    // Chart
    chart1: '#315eae',
    chart2: '#5878b9',
    chart3: '#8da4d6',
    chart4: '#c9d4e8',
    chart5: '#e3ecf7',
    brandMarkText: '#dce6fa',
    rankGoldBg: '#fff4e6',
    rankGoldText: '#b65c22',
    rankGoldBorder: '#e8b47c',
    rankSilverBg: '#f0f2f4',
    rankSilverText: '#56708e',
    rankSilverBorder: '#d8e0e9',
    rankBronzeBg: '#fdf4ee',
    rankBronzeText: '#b06132',
    rankBronzeBorder: '#e7bba3',
  },

  // Heritage geometry: soft cards, slightly tighter controls
  radius: 9,
  radiusSm: 7,
};

/**
 * Type tokens. Playfair Display carries display headings and card titles;
 * Inter carries body and UI text. All six faces are preloaded at the root
 * layout — when using a weighted family name, do NOT also set fontWeight
 * (Android would synthesize a faux weight over the real face).
 */
export const fonts = {
  serif: 'PlayfairDisplay_600SemiBold',
  serifBold: 'PlayfairDisplay_700Bold',
  sans: 'Inter_400Regular',
  sansMedium: 'Inter_500Medium',
  sansSemiBold: 'Inter_600SemiBold',
  sansBold: 'Inter_700Bold',
} as const;

export default colors;
