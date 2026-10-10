// The company's folder template made whole (docs/wave1-plan.md step 13 part 6).
import { describe, expect, it } from 'vitest';
import { normaliseTemplate } from '../src/documents/document-settings.js';

const f = (path: string, restricted = false) => ({ path, restricted });

describe('normaliseTemplate', () => {
  it('adds missing parents first and tidies names', () => {
    expect(normaliseTemplate([f(' Drawings /  Structural  steel '), f('Drawings')])).toEqual([
      f('Drawings'),
      f('Drawings/Structural steel'),
    ]);
  });

  it('keeps the first spelling of a folder and drops repeats', () => {
    expect(normaliseTemplate([f('Money'), f('MONEY/emd'), f('money')])).toEqual([
      f('Money'),
      f('Money/emd'),
    ]);
  });

  it('restricts everything under a restricted folder, wherever it is listed', () => {
    expect(normaliseTemplate([f('Bid/Prices'), f('Bid/Prices/Workings'), f('Bid', true)])).toEqual([
      f('Bid', true),
      f('Bid/Prices', true),
      f('Bid/Prices/Workings', true),
    ]);
  });

  it('refuses names that cannot be folders and templates too deep or too large', () => {
    expect(() => normaliseTemplate([f('a/../b')])).toThrow(/cannot be a folder name/);
    expect(() => normaliseTemplate([f('a\\b')])).toThrow(/cannot be a folder name/);
    expect(() => normaliseTemplate([f(' / ')])).toThrow(/needs a name/);
    expect(() => normaliseTemplate([f('1/2/3/4/5/6/7/8/9')])).toThrow(/at most 8 deep/);
    expect(() =>
      normaliseTemplate(Array.from({ length: 201 }, (_, i) => f(`Folder ${i}`))),
    ).toThrow(/at most 200/);
  });
});
