// Quality's judgements (docs/wave3-plan.md step 14): a test record against its acceptance criteria (held as data),
// and a filled checklist against its template. Pure. [Guessing] The criteria are a quality engineer's to confirm.

export type TestKind = 'cube' | 'slump' | 'steel' | 'soil' | 'brick';
export interface Judgement {
  outcome: 'passed' | 'failed' | 'indicative';
  findings: string[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

export class BadTest extends Error {}

/** fck from a grade written "M25". */
export function fck(grade: unknown) {
  const m = /^M(\d{2,3})$/i.exec(String(grade ?? '').trim());
  if (!m) throw new BadTest('A concrete grade such as M25.');
  return Number(m[1]);
}

/**
 * Concrete cubes: the sample's strength is the mean of its three cubes; no cube may lie more than `maxSpread`% from
 * the mean (else the sample is not valid). At 28 days the sample must reach fck less `individualBelowFck` N/mm² (less
 * `individualBelowFckLow` for grades up to `lowGradeUpTo`). At 7 days the result is indicative, against
 * `sevenDayShare`% of fck.
 */
export function judgeCube(
  spec: { grade: unknown },
  results: { age: unknown; cubes: unknown },
  c: {
    individualBelowFck: number;
    individualBelowFckLow: number;
    lowGradeUpTo: number;
    maxSpread: number;
    sevenDayShare: number;
  },
): Judgement & { mean: number } {
  const f = fck(spec.grade);
  const cubes = Array.isArray(results.cubes) ? results.cubes.map(num) : [];
  if (cubes.length !== 3 || cubes.some((x) => !(x > 0)))
    throw new BadTest('Three cube strengths in N/mm².');
  const age = num(results.age);
  if (age !== 7 && age !== 28) throw new BadTest('Cubes are tested at 7 or 28 days.');
  const mean = r1(cubes.reduce((s, x) => s + x, 0) / 3);
  const findings: string[] = [];
  cubes.forEach((x, i) => {
    const off = (Math.abs(x - mean) / mean) * 100;
    if (off > c.maxSpread)
      findings.push(
        `Cube ${i + 1} (${x}) is ${r1(off)}% from the mean ${mean}: the sample is not valid.`,
      );
  });
  if (age === 7) {
    const want = r1((f * c.sevenDayShare) / 100);
    if (mean < want)
      findings.push(
        `At 7 days ${mean} is below ${want} (${c.sevenDayShare}% of ${f}): watch the 28-day result.`,
      );
    return {
      outcome: findings.some((x) => x.includes('not valid')) ? 'failed' : 'indicative',
      findings,
      mean,
    };
  }
  const min = f - (f <= c.lowGradeUpTo ? c.individualBelowFckLow : c.individualBelowFck);
  if (mean < min) findings.push(`The sample's ${mean} is below ${min} (M${f} less ${f - min}).`);
  return { outcome: findings.length ? 'failed' : 'passed', findings, mean };
}

export function judgeSlump(
  spec: { slump: unknown },
  results: { slump: unknown },
  c: { tolerance: number },
): Judgement {
  const want = num(spec.slump);
  const got = num(results.slump);
  if (!(want > 0) || !(got >= 0)) throw new BadTest('The specified and measured slump in mm.');
  const off = Math.abs(got - want);
  return off > c.tolerance
    ? { outcome: 'failed', findings: [`Slump ${got} mm against ${want} ± ${c.tolerance} mm.`] }
    : { outcome: 'passed', findings: [] };
}

export function judgeSteel(
  spec: { grade: unknown },
  results: { yield: unknown; tensile: unknown; elongation: unknown },
  c: Record<string, { yield: number; tensile: number; ratio: number; elongation: number }>,
): Judgement {
  const g = c[String(spec.grade)];
  if (!g) throw new BadTest(`A steel grade: ${Object.keys(c).join(', ')}.`);
  const [y, t, e] = [num(results.yield), num(results.tensile), num(results.elongation)];
  if (!(y > 0) || !(t > 0) || !(e >= 0))
    throw new BadTest('Yield and tensile strength (N/mm²) and elongation (%).');
  const findings: string[] = [];
  if (y < g.yield) findings.push(`Yield ${y} is below ${g.yield}.`);
  if (t < g.tensile) findings.push(`Tensile strength ${t} is below ${g.tensile}.`);
  if (t / y < g.ratio)
    findings.push(`Tensile ÷ yield ${Math.round((t / y) * 100) / 100} is below ${g.ratio}.`);
  if (e < g.elongation) findings.push(`Elongation ${e}% is below ${g.elongation}%.`);
  return { outcome: findings.length ? 'failed' : 'passed', findings };
}

export function judgeSoil(
  spec: { compaction?: unknown },
  results: { maxDryDensity: unknown; fieldDryDensity: unknown },
  c: { compaction: number },
): Judgement & { compaction: number } {
  const [mdd, fdd] = [num(results.maxDryDensity), num(results.fieldDryDensity)];
  if (!(mdd > 0) || !(fdd > 0)) throw new BadTest('The maximum and field dry densities (g/cc).');
  const want = spec.compaction === undefined ? c.compaction : num(spec.compaction);
  const got = r1((fdd / mdd) * 100);
  return got < want
    ? { outcome: 'failed', findings: [`Compaction ${got}% is below ${want}%.`], compaction: got }
    : { outcome: 'passed', findings: [], compaction: got };
}

export function judgeBrick(
  spec: { class: unknown },
  results: { strengths: unknown; absorption: unknown },
  c: { waterAbsorption: number },
): Judgement & { mean: number } {
  const cls = num(spec.class);
  const s = Array.isArray(results.strengths) ? results.strengths.map(num) : [];
  const abs = num(results.absorption);
  if (!(cls > 0) || !s.length || s.some((x) => !(x > 0)) || !(abs >= 0))
    throw new BadTest("The brick's class, the strengths (N/mm²) and the water absorption (%).");
  const mean = r1(s.reduce((a, x) => a + x, 0) / s.length);
  const findings: string[] = [];
  if (mean < cls) findings.push(`Mean compressive strength ${mean} is below class ${cls}.`);
  if (abs > c.waterAbsorption)
    findings.push(`Water absorption ${abs}% is above ${c.waterAbsorption}%.`);
  return { outcome: findings.length ? 'failed' : 'passed', findings, mean };
}

export interface ChecklistItem {
  text: string;
  kind: 'yes_no' | 'number' | 'note';
  required: boolean;
  min?: number;
  max?: number;
}

/** A filled checklist fails on a required "no", a required item left blank, or a number outside its limits. */
export function judgeChecklist(items: ChecklistItem[], answers: { answer: unknown }[]) {
  if (answers.length !== items.length) throw new BadTest('An answer for each item.');
  const findings: string[] = [];
  items.forEach((it, i) => {
    const a = answers[i]!.answer;
    const blank = a === null || a === undefined || a === '';
    if (blank) {
      if (it.required) findings.push(`${it.text}: not answered.`);
      return;
    }
    if (it.kind === 'yes_no') {
      if (a !== 'yes' && a !== 'no' && a !== 'na') throw new BadTest(`${it.text}: yes, no or n/a.`);
      if (a === 'no' && it.required) findings.push(`${it.text}: no.`);
    } else if (it.kind === 'number') {
      const v = num(a);
      if (Number.isNaN(v)) throw new BadTest(`${it.text}: a number.`);
      if ((it.min !== undefined && v < it.min) || (it.max !== undefined && v > it.max))
        findings.push(`${it.text}: ${v} outside ${it.min ?? '…'}–${it.max ?? '…'}.`);
    }
  });
  return { result: findings.length ? ('failed' as const) : ('passed' as const), findings };
}
