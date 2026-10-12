// Quality's judgements by hand (docs/wave3-plan.md step 14): cubes at 7 and 28 days, a cube off the mean, slump,
// steel, soil compaction, bricks, and a checklist.
import { describe, expect, it } from 'vitest';
import {
  judgeBrick,
  judgeChecklist,
  judgeCube,
  judgeSlump,
  judgeSoil,
  judgeSteel,
} from '../src/quality/quality-rules.js';

const CUBE = {
  individualBelowFck: 3,
  individualBelowFckLow: 2,
  lowGradeUpTo: 15,
  maxSpread: 15,
  sevenDayShare: 65,
};
const STEEL = { Fe500: { yield: 500, tensile: 545, ratio: 1.08, elongation: 12 } };

describe('quality rules', () => {
  it('judges cubes', () => {
    // M25 at 28 days: 26.5, 24, 25 → mean 25.2, at least 22: passed.
    expect(judgeCube({ grade: 'M25' }, { age: 28, cubes: [26.5, 24, 25] }, CUBE)).toEqual({
      outcome: 'passed',
      findings: [],
      mean: 25.2,
    });
    // 21, 21.5, 22 → 21.5 is below 22.
    expect(judgeCube({ grade: 'M25' }, { age: 28, cubes: [21, 21.5, 22] }, CUBE).findings).toEqual([
      "The sample's 21.5 is below 22 (M25 less 3).",
    ]);
    // A cube 20% off the mean: not a valid sample.
    expect(judgeCube({ grade: 'M25' }, { age: 28, cubes: [30, 30, 20] }, CUBE).outcome).toBe(
      'failed',
    );
    // 7 days: 15 against 65% of 25 = 16.3: indicative, with a warning.
    expect(judgeCube({ grade: 'M25' }, { age: 7, cubes: [15, 15, 15] }, CUBE)).toMatchObject({
      outcome: 'indicative',
      findings: ['At 7 days 15 is below 16.3 (65% of 25): watch the 28-day result.'],
    });
    expect(() => judgeCube({ grade: '25' }, { age: 28, cubes: [1, 2, 3] }, CUBE)).toThrow();
  });

  it('judges slump, steel, soil and bricks', () => {
    expect(judgeSlump({ slump: 100 }, { slump: 80 }, { tolerance: 25 }).outcome).toBe('passed');
    expect(judgeSlump({ slump: 100 }, { slump: 130 }, { tolerance: 25 }).findings).toEqual([
      'Slump 130 mm against 100 ± 25 mm.',
    ]);
    expect(
      judgeSteel({ grade: 'Fe500' }, { yield: 540, tensile: 600, elongation: 16 }, STEEL).outcome,
    ).toBe('passed');
    // 560 ÷ 530 = 1.06, under 1.08.
    expect(
      judgeSteel({ grade: 'Fe500' }, { yield: 530, tensile: 560, elongation: 14 }, STEEL).findings,
    ).toEqual(['Tensile ÷ yield 1.06 is below 1.08.']);
    expect(
      judgeSoil({}, { maxDryDensity: 1.92, fieldDryDensity: 1.8 }, { compaction: 95 }),
    ).toEqual({
      outcome: 'failed',
      findings: ['Compaction 93.8% is below 95%.'],
      compaction: 93.8,
    });
    expect(
      judgeBrick(
        { class: 7.5 },
        { strengths: [8, 7.8, 8.1], absorption: 14 },
        { waterAbsorption: 20 },
      ),
    ).toMatchObject({ outcome: 'passed', mean: 8 });
  });

  it('judges a checklist', () => {
    const items = [
      { text: 'Cover blocks placed', kind: 'yes_no' as const, required: true },
      { text: 'Cover (mm)', kind: 'number' as const, required: true, min: 40, max: 50 },
      { text: 'Remarks', kind: 'note' as const, required: false },
    ];
    expect(judgeChecklist(items, [{ answer: 'yes' }, { answer: 45 }, { answer: '' }])).toEqual({
      result: 'passed',
      findings: [],
    });
    expect(
      judgeChecklist(items, [{ answer: 'no' }, { answer: 35 }, { answer: null }]).findings,
    ).toEqual(['Cover blocks placed: no.', 'Cover (mm): 35 outside 40–50.']);
  });
});
