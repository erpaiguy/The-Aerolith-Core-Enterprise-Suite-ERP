// The bar chart of a programme on a canvas (docs/02-tech-stack.md: a custom canvas Gantt). Only the rows and days in
// view are drawn, so a long programme costs no more than a short one. Bars: tasks (red on the critical path), their
// float, milestones (diamonds), summaries; links as elbows with arrowheads; non-working days shaded; the data date.
// On a project schedule: the work done up to the data date darker, finished work grey, and the baseline shown as a
// thin bar under each one.
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  MONTHS,
  dayNo,
  isWorking,
  isoOf,
  type ProgrammeActivity,
  type ProgrammeCalendar,
  type ProgrammeLink,
} from './model';

export const ROW_H = 28;
export const HEAD_H = 44;
export type Zoom = 'day' | 'week' | 'month';
export const PX_PER_DAY: Record<Zoom, number> = { day: 26, week: 7, month: 2 };

interface Colors {
  fg: string;
  muted: string;
  subtle: string;
  line: string;
  surface: string;
  surface2: string;
  bar: string;
  critical: string;
  accent: string;
}
const readColors = (el: Element): Colors => {
  const s = getComputedStyle(el);
  const v = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
  return {
    fg: v('--fg', '#16191f'),
    muted: v('--fg-muted', '#4d5562'),
    subtle: v('--fg-subtle', '#7b8494'),
    line: v('--line', '#d9dde3'),
    surface: v('--surface', '#ffffff'),
    surface2: v('--surface-2', '#f0f2f5'),
    bar: v('--info', '#2563eb'),
    critical: v('--danger', '#c0262d'),
    accent: v('--accent', '#c2410c'),
  };
};

export function Gantt({
  rows,
  links,
  calendar,
  dataDate,
  from,
  to,
  zoom,
  selectedId,
  onSelect,
  scrollTop,
  onScrollTop,
}: {
  rows: ProgrammeActivity[];
  links: ProgrammeLink[];
  calendar: ProgrammeCalendar | undefined;
  dataDate: string;
  /** First and last day shown (day numbers). */
  from: number;
  to: number;
  zoom: Zoom;
  selectedId: string | null;
  onSelect: (id: string) => void;
  scrollTop: number;
  onScrollTop: (top: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const px = PX_PER_DAY[zoom];

  const draw = useCallback(() => {
    const el = box.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const sl = el.scrollLeft;
    const st = el.scrollTop;
    cv.style.transform = `translate(${sl}px, ${st}px)`;
    const g = cv.getContext('2d');
    if (!g) return;
    const c = readColors(el);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = c.surface;
    g.fillRect(0, 0, w, h);

    const x = (day: number) => (day - from) * px - sl;
    const firstDay = from + Math.floor(sl / px);
    const lastDay = Math.min(to, from + Math.ceil((sl + w) / px));
    const firstRow = Math.max(0, Math.floor(st / ROW_H));
    const lastRow = Math.min(rows.length - 1, Math.ceil((st + h - HEAD_H) / ROW_H));
    const y = (i: number) => HEAD_H + i * ROW_H - st;

    // Non-working days and the grid of weeks or months.
    const sets = calendar
      ? { h: new Set(calendar.holidays), w: new Set(calendar.workingDays) }
      : undefined;
    for (let d = firstDay; d <= lastDay; d++) {
      const iso = isoOf(d);
      if (calendar && px >= 4 && !isWorking(calendar, d, sets)) {
        g.fillStyle = c.surface2;
        g.fillRect(x(d), HEAD_H, px, h - HEAD_H);
      }
      const newMonth = iso.endsWith('-01');
      const monday = (((d + 3) % 7) + 7) % 7 === 0;
      if (newMonth || (zoom !== 'month' && monday)) {
        g.strokeStyle = c.line;
        g.lineWidth = newMonth ? 1 : 0.5;
        g.beginPath();
        g.moveTo(Math.round(x(d)) + 0.5, HEAD_H);
        g.lineTo(Math.round(x(d)) + 0.5, h);
        g.stroke();
      }
    }
    // Selected row.
    const sel = rows.findIndex((r) => r.id === selectedId);
    if (sel >= firstRow && sel <= lastRow) {
      g.fillStyle = `${c.accent}1f`;
      g.fillRect(0, y(sel), w, ROW_H);
    }

    // Data date.
    g.strokeStyle = c.accent;
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(Math.round(x(dayNo(dataDate))) + 0.5, HEAD_H);
    g.lineTo(Math.round(x(dayNo(dataDate))) + 0.5, h);
    g.stroke();
    g.setLineDash([]);

    // Links, for rows near the view (a link's ends can be far apart).
    const index = new Map(rows.map((r, i) => [r.id, i]));
    const hasPred = new Set(links.map((l) => l.succ));
    const barEnds = (r: ProgrammeActivity) => {
      const s = dayNo(r.earlyStart!);
      const f = dayNo(r.earlyFinish!) + 1;
      if (r.kind !== 'milestone') return { s: x(s), f: x(f) };
      const at = hasPred.has(r.id) ? x(f) : x(s);
      return { s: at, f: at };
    };
    g.lineWidth = 1;
    for (const l of links) {
      const pi = index.get(l.pred);
      const si = index.get(l.succ);
      if (pi === undefined || si === undefined) continue;
      if (Math.max(pi, si) < firstRow - 1 || Math.min(pi, si) > lastRow + 1) continue;
      const p = rows[pi]!;
      const s = rows[si]!;
      if (!p.earlyStart || !s.earlyStart) continue;
      const pe = barEnds(p);
      const se = barEnds(s);
      const x1 = l.type === 'FS' || l.type === 'FF' ? pe.f : pe.s;
      const x2 = l.type === 'FS' || l.type === 'SS' ? se.s : se.f;
      const y1 = y(pi) + ROW_H / 2;
      const y2 = y(si) + ROW_H / 2;
      const into = l.type === 'FS' || l.type === 'SS' ? 1 : -1; // arrow enters from the left or the right
      g.strokeStyle = g.fillStyle = p.critical && s.critical ? c.critical : c.subtle;
      g.beginPath();
      g.moveTo(x1, y1);
      const out = l.type === 'FS' || l.type === 'FF' ? x1 + 6 : x1 - 6;
      g.lineTo(out, y1);
      const entry = x2 - 6 * into;
      if ((into === 1 && entry >= out) || (into === -1 && entry <= out)) {
        g.lineTo(out, y2);
        g.lineTo(x2, y2);
      } else {
        const mid = y2 + (y2 > y1 ? -ROW_H / 2 : ROW_H / 2);
        g.lineTo(out, mid);
        g.lineTo(entry, mid);
        g.lineTo(entry, y2);
        g.lineTo(x2, y2);
      }
      g.stroke();
      g.beginPath();
      g.moveTo(x2, y2);
      g.lineTo(x2 - 4 * into, y2 - 3);
      g.lineTo(x2 - 4 * into, y2 + 3);
      g.closePath();
      g.fill();
    }

    // Bars.
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let i = firstRow; i <= lastRow; i++) {
      const r = rows[i]!;
      if (!r.earlyStart || !r.earlyFinish) continue;
      const top = y(i);
      const mid = top + ROW_H / 2;
      const { s, f } = barEnds(r);
      if (r.kind === 'summary') {
        g.fillStyle = c.fg;
        g.fillRect(s, top + 8, Math.max(2, f - s), 5);
        // End caps pointing down: ◣ at the start, ◢ at the finish.
        for (const [a, b] of [
          [s, s + 5],
          [f - 5, f],
        ] as const) {
          g.beginPath();
          g.moveTo(a, top + 13);
          g.lineTo(b, top + 13);
          g.lineTo(a === s ? a : b, top + 18);
          g.closePath();
          g.fill();
        }
      } else if (r.kind === 'milestone') {
        g.fillStyle = r.critical ? c.critical : c.fg;
        g.beginPath();
        g.moveTo(s, mid - 6);
        g.lineTo(s + 6, mid);
        g.lineTo(s, mid + 6);
        g.lineTo(s - 6, mid);
        g.closePath();
        g.fill();
      } else {
        // Float: how far the task could slip.
        if (!r.critical && r.lateFinish && r.lateFinish > r.earlyFinish) {
          g.strokeStyle = c.subtle;
          g.beginPath();
          g.moveTo(f, mid + 0.5);
          g.lineTo(x(dayNo(r.lateFinish) + 1), mid + 0.5);
          g.stroke();
        }
        g.fillStyle = r.status === 'finished' ? c.subtle : r.critical ? c.critical : c.bar;
        g.fillRect(s, top + 7, Math.max(2, f - s), ROW_H - 14);
        if (r.status === 'in_progress') {
          // Done so far: from its start to the data date.
          const done = Math.min(f, x(dayNo(dataDate))) - s;
          if (done > 0) {
            g.fillStyle = `${c.fg}66`;
            g.fillRect(s, top + 7, done, ROW_H - 14);
          }
        }
      }
      if (r.baselineStart && r.baselineFinish && r.kind !== 'summary') {
        const bs = x(dayNo(r.baselineStart));
        const bf = x(dayNo(r.baselineFinish) + 1);
        g.fillStyle = c.muted;
        g.fillRect(bs, top + ROW_H - 6, Math.max(2, bf - bs), 3);
      }
      if (zoom !== 'month' || f - s > 0) {
        g.fillStyle = c.muted;
        g.fillText(r.name, f + (r.kind === 'milestone' ? 10 : 6), mid);
      }
    }

    // Timescale on top: months, then days or week starts.
    g.fillStyle = c.surface;
    g.fillRect(0, 0, w, HEAD_H);
    g.strokeStyle = c.line;
    g.beginPath();
    g.moveTo(0, HEAD_H - 0.5);
    g.lineTo(w, HEAD_H - 0.5);
    g.moveTo(0, 22.5);
    g.lineTo(w, 22.5);
    g.stroke();
    g.fillStyle = c.fg;
    g.font = '600 11px system-ui, sans-serif';
    for (let d = firstDay - 31; d <= lastDay; d++) {
      const iso = isoOf(d);
      if (!iso.endsWith('-01') && d !== firstDay) continue;
      // The month already under way at the left edge yields to the next one when they would overlap.
      if (d === firstDay && !iso.endsWith('-01')) {
        const next =
          new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 1)).getTime() /
          86_400_000;
        if (x(next) < 70) continue;
      }
      const [yy, mm] = iso.split('-');
      const label =
        zoom === 'month'
          ? `${MONTHS[Number(mm) - 1]} ${yy!.slice(2)}`
          : `${MONTHS[Number(mm) - 1]} ${yy}`;
      g.fillText(label, Math.max(4, x(d) + 4), 11);
      g.strokeStyle = c.line;
      g.beginPath();
      g.moveTo(Math.round(x(d)) + 0.5, 0);
      g.lineTo(Math.round(x(d)) + 0.5, 22);
      g.stroke();
    }
    g.font = '10px system-ui, sans-serif';
    g.fillStyle = c.muted;
    for (let d = firstDay; d <= lastDay; d++) {
      const iso = isoOf(d);
      const dom = Number(iso.slice(8));
      const monday = (((d + 3) % 7) + 7) % 7 === 0;
      if (zoom === 'day') g.fillText(String(dom), x(d) + px / 2 - (dom > 9 ? 6 : 3), 33);
      else if (zoom === 'week' && monday) g.fillText(String(dom), x(d) + 2, 33);
    }
  }, [rows, links, calendar, dataDate, from, to, px, zoom, selectedId]);

  useLayoutEffect(() => {
    if (box.current && Math.abs(box.current.scrollTop - scrollTop) > 1)
      box.current.scrollTop = scrollTop;
    draw();
  }, [draw, scrollTop]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', draw);
    return () => {
      ro.disconnect();
      media.removeEventListener('change', draw);
    };
  }, [draw]);

  // Start at the data date.
  useEffect(() => {
    if (box.current) box.current.scrollLeft = Math.max(0, (dayNo(dataDate) - from - 3) * px);
  }, [dataDate, from, px]);

  return (
    <div
      ref={box}
      className="relative min-w-0 flex-1 overflow-auto"
      onScroll={(e) => {
        draw();
        onScrollTop(e.currentTarget.scrollTop);
      }}
      onClick={(e) => {
        const el = box.current!;
        const rect = el.getBoundingClientRect();
        const i = Math.floor((e.clientY - rect.top - HEAD_H + el.scrollTop) / ROW_H);
        if (e.clientY - rect.top > HEAD_H && rows[i]) onSelect(rows[i]!.id);
      }}
      data-testid="gantt"
    >
      <div style={{ width: (to - from + 1) * px, height: HEAD_H + rows.length * ROW_H + 40 }} />
      <canvas
        ref={canvas}
        className="pointer-events-none absolute left-0 top-0"
        role="img"
        aria-label="Bar chart of the programme"
      />
    </div>
  );
}
