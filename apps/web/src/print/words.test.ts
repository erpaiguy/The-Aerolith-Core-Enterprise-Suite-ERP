import { describe, expect, it } from 'vitest';
import { rupeesInWords } from './words';

describe('rupees in words', () => {
  it('reads lakh and crore, and paise', () => {
    expect(rupeesInWords('125000.50')).toBe(
      'Rupees one lakh twenty-five thousand and paise fifty only',
    );
    expect(rupeesInWords(31_02_45_678)).toBe(
      'Rupees thirty-one crore two lakh forty-five thousand six hundred and seventy-eight only',
    );
    expect(rupeesInWords('0')).toBe('Rupees zero only');
    expect(rupeesInWords('1001')).toBe('Rupees one thousand one only');
  });
});
