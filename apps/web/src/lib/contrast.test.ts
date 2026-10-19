// Every text colour in the design tokens meets WCAG AA (4.5:1) on every surface it is used on, in both themes
// (docs/wave9-plan.md step 9a.1). Reads the tokens file itself, so a colour changed there is checked here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Tests run from apps/web (happy-dom gives import.meta.url an http: scheme).
const css = readFileSync(join(process.cwd(), '../../packages/ui/src/tokens.css'), 'utf8');

const block = (selector: RegExp) => {
  const m = selector.exec(css);
  if (!m) throw new Error(`No block ${String(selector)}`);
  const body = css.slice(m.index + m[0].length, css.indexOf('}', m.index));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((x) => [x[1]!, x[2]!]),
  );
};
const light = block(/^:root \{/m);
const dark = block(/^:root\[data-theme='dark'\] \{/m);
const darkByOs = block(/:root:not\(\[data-theme='light'\]\) \{/);

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
/** `fg` at `alpha` over `bg`, as a badge's tinted background is drawn. */
const tint = (fg: string, bg: string, alpha: number) =>
  `#${rgb(fg)
    .map((v, i) => Math.round(v * alpha + rgb(bg)[i]! * (1 - alpha)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;

const TEXT = ['fg', 'fg-muted', 'fg-subtle', 'accent', 'info', 'success', 'warning', 'danger'];
const SURFACES = ['canvas', 'surface', 'surface-2'];
const BADGES = ['accent', 'success', 'warning', 'danger'];

describe.each([
  ['light', light],
  ['dark', dark],
])('the %s theme', (_, t) => {
  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))(
    '%s text on %s is AA',
    (fg, bg) => {
      expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
    },
  );
  it.each(BADGES)('a %s badge is AA', (tone) => {
    expect(ratio(t[tone]!, tint(t[tone]!, t.surface!, 0.15))).toBeGreaterThanOrEqual(4.5);
  });
  it('button text on its fill is AA', () => {
    expect(ratio(t['accent-fg']!, t.accent!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t['accent-fg']!, t['accent-hover']!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t['danger-fg']!, t.danger!)).toBeGreaterThanOrEqual(4.5);
  });
});

it('the dark theme is the same whether the OS or the person chooses it', () => {
  expect(darkByOs).toEqual(dark);
});
