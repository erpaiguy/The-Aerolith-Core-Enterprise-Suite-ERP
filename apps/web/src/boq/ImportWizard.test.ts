import { describe, expect, it } from 'vitest';
import { columnName } from './ImportWizard';

describe('columnName', () => {
  it('names columns as Excel does', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });
});
