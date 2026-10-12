// Review workflows' rules by hand (docs/wave5-plan.md step 1).
import { describe, expect, it } from 'vitest';
import { stageOutcome, worst } from '../src/dms/review-rules.js';

describe('review rules', () => {
  it('closes stages by mode and takes the worst effect', () => {
    expect(worst(['approve', 'approve_comments'])).toBe('approve_comments');
    expect(worst(['return', 'reject', 'approve'])).toBe('reject');
    // Everyone: open until all answer, unless someone returns or rejects.
    expect(stageOutcome('all', ['approve', null])).toBeNull();
    expect(stageOutcome('all', ['approve', 'approve_comments'])).toBe('approve_comments');
    expect(stageOutcome('all', ['return', null])).toBe('return');
    // Anyone: the first answer decides.
    expect(stageOutcome('any', [null, 'approve'])).toBe('approve');
    expect(stageOutcome('any', [null, null])).toBeNull();
  });
});
