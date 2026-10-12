// Revision labels (docs/wave5-plan.md step 4): a preliminary series P1, P2… for information and approval, then a
// construction series of numbers (0, 1, 2…), letters (A, B… Z) or R-numbers (R0, R1…). Each new revision must be
// the next label in its series; once a construction label exists there is no going back to P.

export type Construction = 'numbers' | 'letters' | 'r_numbers';
export interface Scheme {
  enabled: boolean;
  construction: Construction;
}
export type Purpose = 'information' | 'approval' | 'construction';

const PRELIM = /^P([1-9]\d{0,2})$/;
const SERIES: Record<
  Construction,
  { re: RegExp; first: string; next: (l: string) => string | null }
> = {
  numbers: {
    re: /^(0|[1-9]\d{0,2})$/,
    first: '0',
    next: (l) => String(Number(l) + 1),
  },
  letters: {
    re: /^[A-Z]$/,
    first: 'A',
    next: (l) => (l === 'Z' ? null : String.fromCharCode(l.charCodeAt(0) + 1)),
  },
  r_numbers: {
    re: /^R(0|[1-9]\d{0,2})$/,
    first: 'R0',
    next: (l) => `R${Number(l.slice(1)) + 1}`,
  },
};

const norm = (l: string) => l.trim().toUpperCase();

/** The labels a new revision may take after `existing` (in the order they were added). */
export function nextLabels(
  scheme: Scheme,
  existing: string[],
): { preliminary: string | null; construction: string | null } {
  const s = SERIES[scheme.construction];
  const labels = existing.map(norm);
  const lastC = [...labels].reverse().find((l) => s.re.test(l));
  if (lastC !== undefined) return { preliminary: null, construction: s.next(lastC) };
  const lastP = [...labels].reverse().find((l) => PRELIM.test(l));
  return {
    preliminary: lastP ? `P${Number(PRELIM.exec(lastP)![1]) + 1}` : 'P1',
    construction: s.first,
  };
}

export type Verdict = { ok: true; label: string } | { ok: false; code: string; message: string };

/** Checks a candidate label against the scheme, the labels so far and the purpose. */
export function checkLabel(
  scheme: Scheme,
  existing: string[],
  candidate: string,
  purpose: Purpose,
): Verdict {
  if (!scheme.enabled) return { ok: true, label: candidate.trim() };
  const label = norm(candidate);
  const next = nextLabels(scheme, existing);
  const isP = PRELIM.test(label);
  const isC = SERIES[scheme.construction].re.test(label);
  if (!isP && !isC)
    return {
      ok: false,
      code: 'bad_label',
      message: `"${candidate.trim()}" is not a label of this project's series (P1, P2… then ${SERIES[scheme.construction].first}…).`,
    };
  if (purpose === 'construction' && !isC)
    return {
      ok: false,
      code: 'construction_label',
      message: `A drawing for construction takes a construction label (${next.construction ?? 'none left'}).`,
    };
  const expected = isP ? next.preliminary : next.construction;
  if (expected === null)
    return {
      ok: false,
      code: isP ? 'no_going_back' : 'series_ended',
      message: isP
        ? 'This drawing has gone to construction revisions; preliminary labels are closed.'
        : 'The series has no labels left.',
    };
  if (label !== expected)
    return {
      ok: false,
      code: 'not_next',
      message: `The next revision is ${[next.preliminary, next.construction].filter(Boolean).join(' or ')}, not ${label}.`,
    };
  return { ok: true, label };
}
