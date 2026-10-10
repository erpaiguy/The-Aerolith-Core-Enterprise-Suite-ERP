// Kinds of BOQ item (migration 0016). Rate-only items and alternates are priced but have no amount, so they are in
// no total; provisional sums count in the total but take no pricing markups.
export const ITEM_KINDS = ['normal', 'provisional', 'rate_only', 'alternate'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The item's amount counts in subtotals and the total. */
export const counted = (kind: ItemKind) => kind === 'normal' || kind === 'provisional';

/** As written in the Type column of an exported BOQ, and read back on import. */
export const KIND_LABEL: Record<ItemKind, string> = {
  normal: 'item',
  provisional: 'provisional sum',
  rate_only: 'rate only',
  alternate: 'alternate',
};

/** A Type column's text, read leniently: "PS", "Provisional", "Rate-only", "Option"... */
export function kindFromText(text: string): ItemKind | null {
  const t = text.toLowerCase().replace(/[\s_.-]+/g, '');
  if (['item', 'normal'].includes(t)) return 'normal';
  if (['provisionalsum', 'provisional', 'ps', 'provsum'].includes(t)) return 'provisional';
  if (['rateonly', 'rateonlyitem', 'ro'].includes(t)) return 'rate_only';
  if (['alternate', 'alternative', 'option', 'optional', 'alt'].includes(t)) return 'alternate';
  return null;
}
