// Hierarchical fractional sort keys for BOQ lines (docs/05-database.md §4). Used by the API and the benchmark.
//
// A node's key is its parent's key + SEPARATOR + its own segment. Segments are base-36 digit strings compared
// byte-wise (COLLATE "C"). The separator sorts below every digit, so `ORDER BY sort_key` yields depth-first
// tree order, and a new segment can always be generated between two siblings without renumbering anything.

export const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
export const SEPARATOR = '!';
// Upper bound for "everything inside this node's subtree": sorts after SEPARATOR but before every digit.
export const SUBTREE_END = '"';

const digitValue = (ch: string): number => {
  const v = DIGITS.indexOf(ch);
  if (v < 0) throw new Error(`invalid sort-key digit: ${ch}`);
  return v;
};

/** Fixed-width segment for bulk generation. Ends in a non-zero digit, which `midpoint` requires. */
export function segmentFor(index: number, width = 4): string {
  if (!Number.isInteger(index) || index < 0 || index >= 36 ** width) {
    throw new Error(`segment index out of range: ${index}`);
  }
  return index.toString(36).padStart(width, '0') + 'h';
}

/**
 * Returns a segment strictly between `a` and `b` (`a` = '' means no lower bound, `b` = null means no upper bound).
 * Neither input may end in '0'; the result never does either.
 */
export function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`midpoint: ${a} >= ${b}`);
  if (a.endsWith('0') || (b !== null && b.endsWith('0')))
    throw new Error('midpoint: trailing zero');
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a.length > 0 ? digitValue(a[0] as string) : 0;
  const digitB = b !== null ? digitValue(b[0] as string) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)] as string;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

export const childKey = (parentKey: string, segment: string): string =>
  parentKey === '' ? segment : parentKey + SEPARATOR + segment;

/** Splits a key into its parent key and own segment. */
export function splitKey(key: string): { parent: string; segment: string } {
  const i = key.lastIndexOf(SEPARATOR);
  return i < 0
    ? { parent: '', segment: key }
    : { parent: key.slice(0, i), segment: key.slice(i + 1) };
}

/** Every ancestor key of `key`, root first: 'a!b!c' -> ['a', 'a!b']. */
export function ancestorKeys(key: string): string[] {
  const parts = key.split(SEPARATOR);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join(SEPARATOR));
}
