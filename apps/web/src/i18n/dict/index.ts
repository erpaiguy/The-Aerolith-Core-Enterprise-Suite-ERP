// Each area keeps its own strings; they are merged here. A string missing from a language shows in English.
import { common } from './common';
import { dailyReport } from './daily-report';
import { muster } from './muster';
import { quality } from './quality';
import { safety } from './safety';
import { stores } from './stores';

type Dict = Record<string, string>;
export type AreaDict = { mr: Dict; hi: Dict };

const areas: AreaDict[] = [common, dailyReport, muster, stores, quality, safety];

export const DICTIONARIES: Record<'mr' | 'hi', Dict> = {
  mr: Object.assign({}, ...areas.map((a) => a.mr)) as Dict,
  hi: Object.assign({}, ...areas.map((a) => a.hi)) as Dict,
};
