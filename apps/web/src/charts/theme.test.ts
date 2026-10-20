// The chart theme (docs/wave9-plan.md step 9a.6): built from the tokens, the palette by scheme, motion off on request,
// and rebuilt when the page's theme changes.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PALETTE } from './palette';
import { buildTheme, readTokens, schemeOf, useChartTheme, type Tokens } from './theme';

const light: Tokens = {
  surface: '#ffffff',
  fg: '#16191f',
  muted: '#4d5562',
  line: '#d9dde3',
  lineStrong: '#b8bec8',
};
const dark: Tokens = {
  surface: '#171a20',
  fg: '#e8eaee',
  muted: '#a7aebb',
  line: '#2f3540',
  lineStrong: '#444c59',
};

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

describe('buildTheme', () => {
  it('takes the light palette and the tokens on a light surface', () => {
    const t = buildTheme(light, false);
    expect(t.color).toEqual([...PALETTE.light]);
    expect(t.textStyle.color).toBe(light.muted);
    expect(t.tooltip.backgroundColor).toBe(light.surface);
    expect(t.tooltip.textStyle.color).toBe(light.fg);
    expect(t.valueAxis.splitLine.lineStyle.color).toBe(light.line);
    expect(t.categoryAxis.axisLine.lineStyle.color).toBe(light.lineStrong);
    expect(t.animation).toBe(true);
  });
  it('takes the dark palette on a dark surface, and no animation for reduced motion', () => {
    const t = buildTheme(dark, true);
    expect(schemeOf(dark)).toBe('dark');
    expect(t.color).toEqual([...PALETTE.dark]);
    expect(t.pie.itemStyle.borderColor).toBe(dark.surface);
    expect(t.animation).toBe(false);
  });
});

describe('useChartTheme', () => {
  it('reads the CSS variables and follows a change of theme', async () => {
    const root = document.documentElement;
    root.style.setProperty('--surface', light.surface);
    const { result } = renderHook(() => useChartTheme());
    expect(readTokens().surface).toBe(light.surface);
    expect(result.current.theme.color).toEqual([...PALETTE.light]);
    const before = result.current.key;
    await act(async () => {
      root.style.setProperty('--surface', dark.surface);
      root.style.setProperty('--fg-muted', dark.muted);
      root.setAttribute('data-theme', 'dark');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.key).not.toBe(before);
    expect(result.current.theme.color).toEqual([...PALETTE.dark]);
    expect(result.current.theme.textStyle.color).toBe(dark.muted);
  });
});
