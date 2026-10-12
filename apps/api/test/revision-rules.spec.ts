import { describe, expect, it } from 'vitest';
import { checkLabel, nextLabels, type Scheme } from '../src/dms/revision-rules.js';

const numbers: Scheme = { enabled: true, construction: 'numbers' };
const letters: Scheme = { enabled: true, construction: 'letters' };
const r: Scheme = { enabled: true, construction: 'r_numbers' };

describe('revision rules', () => {
  it('offers P1 or the first construction label to start', () => {
    expect(nextLabels(numbers, [])).toEqual({ preliminary: 'P1', construction: '0' });
    expect(nextLabels(letters, ['P1', 'P2'])).toEqual({ preliminary: 'P3', construction: 'A' });
    expect(nextLabels(r, ['P1', 'R0'])).toEqual({ preliminary: null, construction: 'R1' });
  });

  it('takes only the next label, and no P once construction has started', () => {
    expect(checkLabel(numbers, [], 'p1', 'approval')).toEqual({ ok: true, label: 'P1' });
    expect(checkLabel(numbers, ['P1'], 'P3', 'approval')).toMatchObject({
      ok: false,
      code: 'not_next',
    });
    expect(checkLabel(numbers, ['P1', 'P2'], '0', 'construction')).toEqual({
      ok: true,
      label: '0',
    });
    expect(checkLabel(numbers, ['P1', '0'], 'P2', 'approval')).toMatchObject({
      ok: false,
      code: 'no_going_back',
    });
    expect(checkLabel(numbers, ['P1', '0'], '2', 'construction')).toMatchObject({
      ok: false,
      code: 'not_next',
      message: 'The next revision is 1, not 2.',
    });
  });

  it('needs a construction label for construction, and refuses strangers', () => {
    expect(checkLabel(letters, [], 'P1', 'construction')).toMatchObject({
      ok: false,
      code: 'construction_label',
    });
    expect(checkLabel(letters, [], 'rev A', 'approval')).toMatchObject({
      ok: false,
      code: 'bad_label',
    });
    expect(checkLabel(letters, ['Z'], 'P1', 'approval')).toMatchObject({
      ok: false,
      code: 'no_going_back',
    });
    expect(nextLabels(letters, ['Y', 'Z']).construction).toBeNull();
    expect(checkLabel(letters, ['Z'], 'Z', 'construction')).toMatchObject({ code: 'series_ended' });
  });

  it('lets anything through when off', () => {
    expect(
      checkLabel({ enabled: false, construction: 'numbers' }, ['P1'], 'Rev-7', 'approval'),
    ).toEqual({
      ok: true,
      label: 'Rev-7',
    });
  });
});
