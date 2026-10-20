// The one categorical palette every chart uses (docs/wave9-plan.md step 9a.6). Okabe and Ito's colour-blind-safe set,
// in their order: orange, sky blue, bluish green, yellow, blue, vermillion, reddish purple, then a neutral where they
// have black. Their pale colours are darkened for the light theme and their dark ones lightened for the dark theme,
// each by the least that gives 3:1 against the chart's surface (non-text graphics need 3:1, WCAG 1.4.11) while keeping
// the hues apart. palette.test.ts checks both against the surface colours in packages/ui/src/tokens.css.
export const PALETTE = {
  light: [
    '#b57c00', // orange
    '#3d8dc4', // sky blue
    '#008f68', // bluish green
    '#8c8200', // yellow (olive on white)
    '#005b8f', // blue
    '#d55e00', // vermillion
    '#b5578d', // reddish purple
    '#5a6270', // neutral
  ],
  dark: ['#e69f00', '#56b4e9', '#009e73', '#f0e442', '#2f8fd6', '#e8702a', '#cc79a7', '#b8bec8'],
} as const;

export type Scheme = keyof typeof PALETTE;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Relative luminance (WCAG 2.1) of a #rrggbb colour. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** How far apart two colours look (CIE76 ΔE in Lab; about 10 is plainly different side by side). */
export function distance(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, b] = rgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
    const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
    const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
}
