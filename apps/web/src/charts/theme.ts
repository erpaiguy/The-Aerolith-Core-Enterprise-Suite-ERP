// The chart theme (docs/wave9-plan.md step 9a.6): built from the design tokens in packages/ui/src/tokens.css, read
// from the page at runtime, so charts follow light and dark and change with them, whether the person picks a theme
// (data-theme on <html>) or the OS switches. The series colours come from palette.ts. No animation for those who
// ask for reduced motion.
import { useEffect, useState } from 'react';
import { PALETTE, luminance, type Scheme } from './palette';

export interface Tokens {
  surface: string;
  fg: string;
  muted: string;
  line: string;
  lineStrong: string;
}

const LIGHT: Tokens = {
  surface: '#ffffff',
  fg: '#16191f',
  muted: '#4d5562',
  line: '#d9dde3',
  lineStrong: '#b8bec8',
};

/** The tokens as the page has them now (the light theme's where the stylesheet is not loaded). */
export function readTokens(): Tokens {
  if (typeof document === 'undefined') return LIGHT;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    surface: v('--surface', LIGHT.surface),
    fg: v('--fg', LIGHT.fg),
    muted: v('--fg-muted', LIGHT.muted),
    line: v('--line', LIGHT.line),
    lineStrong: v('--line-strong', LIGHT.lineStrong),
  };
}

/** Dark when the surface is dark, whatever made it so. */
export const schemeOf = (t: Tokens): Scheme =>
  /^#[0-9a-f]{6}$/i.test(t.surface) && luminance(t.surface) < 0.2 ? 'dark' : 'light';

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** An ECharts theme object from the tokens. */
export function buildTheme(t: Tokens, reducedMotion: boolean) {
  const axisCommon = {
    axisLine: { show: true, lineStyle: { color: t.lineStrong } },
    axisTick: { lineStyle: { color: t.lineStrong } },
    axisLabel: { color: t.muted },
    nameTextStyle: { color: t.muted },
    splitLine: { lineStyle: { color: t.line } },
  };
  return {
    color: [...PALETTE[schemeOf(t)]],
    backgroundColor: 'transparent',
    textStyle: { color: t.muted, fontFamily: 'inherit' },
    legend: { textStyle: { color: t.muted }, inactiveColor: t.lineStrong },
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.line,
      textStyle: { color: t.fg },
      confine: true,
    },
    categoryAxis: { ...axisCommon, splitLine: { show: false } },
    valueAxis: { ...axisCommon, axisLine: { show: false } },
    line: { lineStyle: { width: 2 }, symbolSize: 6 },
    bar: { barMaxWidth: 36 },
    pie: { itemStyle: { borderColor: t.surface, borderWidth: 1 } },
    animation: !reducedMotion,
  };
}

export type ChartTheme = ReturnType<typeof buildTheme>;

/**
 * The current theme, rebuilt when <html>'s data-theme or class changes, or the OS colour scheme or motion setting
 * does. `key` changes with it, for the chart to be drawn again.
 */
export function useChartTheme(): { theme: ChartTheme; key: string } {
  const read = () => {
    const tokens = readTokens();
    const reduced = prefersReducedMotion();
    return { theme: buildTheme(tokens, reduced), key: `${JSON.stringify(tokens)}:${reduced}` };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () =>
      setState((prev) => {
        const next = read();
        return next.key === prev.key ? prev : next;
      });
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });
    const queries =
      typeof window.matchMedia === 'function'
        ? ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)'].map((q) =>
            window.matchMedia(q),
          )
        : [];
    queries.forEach((q) => q.addEventListener('change', update));
    update();
    return () => {
      observer.disconnect();
      queries.forEach((q) => q.removeEventListener('change', update));
    };
  }, []);
  return state;
}
