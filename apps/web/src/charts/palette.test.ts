// The chart palette (docs/wave9-plan.md step 9a.6): colours plainly apart, and each at least 3:1 against the chart's
// surface in both themes (non-text graphics, WCAG 1.4.11). Reads the surfaces from the tokens file itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PALETTE, contrast, distance } from './palette';

// Tests run from apps/web.
const css = readFileSync(join(process.cwd(), '../../packages/ui/src/tokens.css'), 'utf8');
const token = (selector: RegExp, name: string) => {
  const m = selector.exec(css);
  if (!m) throw new Error(`No block ${String(selector)}`);
  const body = css.slice(m.index, css.indexOf('}', m.index));
  return new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(body)![1]!;
};
const LIGHT = /^:root \{/m;
const DARK = /^:root\[data-theme='dark'\] \{/m;

describe.each([
  ['light', PALETTE.light, LIGHT],
  ['dark', PALETTE.dark, DARK],
] as const)('the %s palette', (_, colours, block) => {
  it('has eight distinct colours, each plainly apart from the others', () => {
    expect(new Set(colours.map((c) => c.toLowerCase())).size).toBe(8);
    for (let i = 0; i < colours.length; i++)
      for (let j = i + 1; j < colours.length; j++)
        expect([colours[i], colours[j], distance(colours[i]!, colours[j]!)]).toEqual([
          colours[i],
          colours[j],
          expect.toSatisfy((d: number) => d >= 15),
        ]);
  });
  it.each(['surface', 'surface-2'])('gives every colour 3:1 against %s', (surface) => {
    const bg = token(block, surface);
    for (const c of colours)
      expect([c, contrast(c, bg)]).toEqual([c, expect.toSatisfy((r: number) => r >= 3)]);
  });
});

describe('the contrast helper', () => {
  it('agrees with WCAG on black and white', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
  });
});
