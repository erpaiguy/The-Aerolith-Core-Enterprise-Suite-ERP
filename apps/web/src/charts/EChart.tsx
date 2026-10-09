// Charts with Apache ECharts (docs/08-dashboard.md §1; Apache-2.0, renderer zrender BSD-3-Clause). Only the chart
// types used here are imported, so the bundle carries bar, line and pie and nothing else. Colours come from the app's
// theme tokens, so charts follow light and dark mode.
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export type ChartOption = echarts.EChartsCoreOption;
export interface ChartClick {
  name: string;
  dataIndex: number;
  seriesName?: string;
}

/** The theme's colours as the chart needs them (CSS variables resolved). */
export function themeColours() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    fg: v('--fg', '#1f2937'),
    muted: v('--fg-muted', '#6b7280'),
    line: v('--line', '#e5e7eb'),
    accent: v('--accent', '#c2410c'),
    success: v('--success', '#15803d'),
    danger: v('--danger', '#b91c1c'),
    warning: v('--warning', '#b45309'),
    info: v('--info', '#1d4ed8'),
  };
}

export function EChart({
  option,
  label,
  height = 260,
  onClick,
}: {
  option: ChartOption;
  /** What the chart shows, for screen readers (the figures are also in a table or the Excel file). */
  label: string;
  height?: number;
  onClick?: ((e: ChartClick) => void) | undefined;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const click = useRef(onClick);
  click.current = onClick;

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const c = echarts.init(node, undefined, { renderer: 'canvas' });
    chart.current = c;
    c.on('click', (p) => click.current?.(p as unknown as ChartClick));
    const resize = new ResizeObserver(() => c.resize());
    resize.observe(node);
    return () => {
      resize.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const t = themeColours();
    chart.current?.setOption(
      {
        textStyle: { color: t.muted, fontFamily: 'inherit' },
        animation: false,
        ...option,
      },
      { notMerge: true },
    );
  }, [option]);

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
