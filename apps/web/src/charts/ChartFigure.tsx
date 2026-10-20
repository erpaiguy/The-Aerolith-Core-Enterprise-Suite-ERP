// A chart as every screen shows it (docs/wave9-plan.md step 9a.6): the chart in the house theme with tooltips in full
// figures, a Table button that shows the same series as a table (its caption the chart's title), Download CSV of that
// table, and drill-down: clicking a bar, point or slice, or its row's label in the table, opens what it counts.
// Screen readers get the canvas as an image with a summary, and the table.
import { Button } from '@aerolith/ui';
import { useRouter } from '@tanstack/react-router';
import { Download, Table2 } from 'lucide-react';
import { useMemo, useState, type MouseEvent } from 'react';
import { useT } from '../i18n/i18n';
import { EChart, type ChartClick, type ChartOption } from './EChart';
import { formatFull } from './measure';
import {
  chartTable,
  formatCell,
  measureFor,
  summarise,
  toCsv,
  type ChartTableData,
  type Measures,
} from './table';

/** Where a click on a chart goes: a route in the app, or nowhere (undefined). */
export type Drill = (c: ChartClick) => string | undefined;

/** Opens the route a click maps to. One helper, so every chart drills the same way. */
export function useDrill(drill: Drill | undefined): ((c: ChartClick) => void) | undefined {
  const router = useRouter();
  return useMemo(
    () =>
      drill &&
      ((c: ChartClick) => {
        const to = drill(c);
        if (to) router.history.push(to);
      }),
    [drill, router],
  );
}

/** Tooltips in full figures with units, unless the screen set its own. */
function withTooltips(option: ChartOption, measures: Measures): ChartOption {
  const list = (Array.isArray(option.series) ? option.series : [option.series]).filter(Boolean) as {
    name?: string;
    type?: string;
    tooltip?: Record<string, unknown>;
  }[];
  const pie = list.some((s) => s.type === 'pie');
  return {
    ...option,
    tooltip: { trigger: pie ? 'item' : 'axis', ...(option.tooltip as object | undefined) },
    series: list.map((s) =>
      s.tooltip?.valueFormatter
        ? s
        : {
            ...s,
            tooltip: {
              ...s.tooltip,
              valueFormatter: (v: unknown) => formatFull(v, measureFor(measures, s.name ?? '')),
            },
          },
    ),
  };
}

export function ChartFigure({
  title,
  label,
  option,
  measures,
  heading,
  height,
  drill,
  onPick,
}: {
  /** The chart's title: the table's caption and the CSV file's name. */
  title: string;
  /** What the chart shows, for screen readers; a summary of the figures is added. */
  label: string;
  option: ChartOption;
  /** What the numbers are: one for the chart, or by series name. */
  measures: Measures;
  /** What the categories are, as the table's first heading (Stage, Month, Week). */
  heading: string;
  height?: number | undefined;
  /** A click to a route (the list or report behind the chart). */
  drill?: Drill | undefined;
  /** Or a click handled on the screen itself (a week chosen). */
  onPick?: ((c: ChartClick) => void) | undefined;
}) {
  const t = useT();
  const [asTable, setAsTable] = useState(false);
  const go = useDrill(drill);
  const pick = onPick ?? go;
  // Screens pass measures inline; compare them by content so the chart is not redrawn on every render.
  const same = JSON.stringify(measures);
  const themed = useMemo(() => withTooltips(option, measures), [option, same]);
  const table = useMemo(() => chartTable(option, measures, heading), [option, same, heading]);
  const download = () => {
    // A byte-order mark so Excel reads ₹ and Devanagari as UTF-8.
    const blob = new Blob(['\uFEFF', toCsv(table)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]+/g, '-')}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return (
    <figure aria-label={title} className="space-y-2">
      <div className="flex justify-end gap-1 print:hidden">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={asTable}
          onClick={() => setAsTable(!asTable)}
          title={t('Show the figures as a table')}
        >
          <Table2 className="size-4" aria-hidden /> {t('Table')}
        </Button>
        <Button variant="ghost" size="sm" onClick={download}>
          <Download className="size-4" aria-hidden /> {t('Download CSV')}
        </Button>
      </div>
      {asTable ? (
        <ChartTable
          data={table}
          caption={title}
          onPick={pick ? (i) => pick({ name: table.rows[i]!.label, dataIndex: i }) : undefined}
          hrefOf={
            !onPick && drill
              ? (i) => drill({ name: table.rows[i]!.label, dataIndex: i })
              : undefined
          }
        />
      ) : (
        <EChart
          option={themed}
          label={`${label}. ${summarise(table, t)}`}
          height={height}
          onClick={pick}
        />
      )}
    </figure>
  );
}

/** The figures of a chart as an accessible table; row labels open what they count when the chart drills. */
export function ChartTable({
  data,
  caption,
  onPick,
  hrefOf,
}: {
  data: ChartTableData;
  caption: string;
  onPick?: ((row: number) => void) | undefined;
  hrefOf?: ((row: number) => string | undefined) | undefined;
}) {
  const t = useT();
  const cell = (i: number) => {
    const text = data.rows[i]!.label;
    const href = hrefOf?.(i);
    if (href)
      return (
        <a
          href={href}
          className="text-accent hover:underline"
          onClick={(e: MouseEvent) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            onPick?.(i);
          }}
        >
          {text}
        </a>
      );
    if (onPick && !hrefOf)
      return (
        <button
          type="button"
          className="text-left text-accent hover:underline"
          onClick={() => onPick(i)}
        >
          {text}
        </button>
      );
    return text;
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-xs text-fg-muted">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {data.heading}
            </th>
            {data.columns.map((c) => (
              <th key={c.name} scope="col" className="py-1.5 pl-3 text-right font-medium">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.length === 0 ? (
            <tr>
              <td colSpan={data.columns.length + 1} className="py-2 text-fg-muted">
                {t('No figures.')}
              </td>
            </tr>
          ) : (
            data.rows.map((r, i) => (
              <tr key={`${r.label}-${i}`} className="border-t border-line">
                <th scope="row" className="py-1.5 pr-3 font-normal">
                  {cell(i)}
                </th>
                {r.values.map((v, j) => (
                  <td key={j} className="py-1.5 pl-3 text-right tabular-nums">
                    {formatCell(v, data.columns[j]!.measure)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
