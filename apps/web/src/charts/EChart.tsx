// Charts with Apache ECharts (docs/08-dashboard.md §1; Apache-2.0, renderer zrender BSD-3-Clause). Only the chart
// types used here are imported, so the bundle carries bar, line and pie and nothing else. The look comes from one
// theme built from the app's design tokens (theme.ts, step 9a.6), so every chart matches and follows light and dark.
// Most screens draw through ChartFigure, which adds the table view, CSV and drill-down.
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { readTokens, useChartTheme } from './theme';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export type ChartOption = echarts.EChartsCoreOption;
export interface ChartClick {
  name: string;
  dataIndex: number;
  seriesName?: string;
}

/** The theme's colours as a chart needs them for a mark of its own (CSS variables resolved). */
export function themeColours() {
  const t = readTokens();
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    fg: t.fg,
    muted: t.muted,
    line: t.line,
    accent: v('--accent', '#b23c0b'),
    success: v('--success', '#137336'),
    danger: v('--danger', '#b9232a'),
    warning: v('--warning', '#9a4a08'),
    info: v('--info', '#1d5bd8'),
  };
}

export function EChart({
  option,
  label,
  height = 260,
  onClick,
}: {
  option: ChartOption;
  /** What the chart shows, for screen readers (the figures are also in its table view). */
  label: string;
  height?: number | undefined;
  onClick?: ((e: ChartClick) => void) | undefined;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const click = useRef(onClick);
  click.current = onClick;
  const { theme, key } = useChartTheme();

  // Drawn again from scratch when the theme changes: ECharts takes its theme only when a chart is made.
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const c = echarts.init(node, theme, { renderer: 'canvas' });
    chart.current = c;
    c.on('click', (p) => click.current?.(p as unknown as ChartClick));
    const resize = new ResizeObserver(() => c.resize());
    resize.observe(node);
    return () => {
      resize.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, [key]); // `key` names `theme`

  useEffect(() => {
    // Legends on for every chart, at the top unless the chart places its own.
    chart.current?.setOption({ legend: { top: 0, type: 'scroll' }, ...option }, { notMerge: true });
  }, [option, key]);

  return (
    <div
      ref={el}
      role="img"
      aria-label={label}
      style={{ height, cursor: onClick ? 'pointer' : undefined }}
      className="w-full"
    />
  );
}
