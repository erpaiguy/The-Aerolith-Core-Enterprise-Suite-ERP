// Where the grid is in the whole BOQ (docs/wave1-plan.md step 13): the grid holds a few hundred lines at a time, so
// its own scrollbar cannot reach line 600,000 of a million. This bar shows the line at the top of the view, slides
// to any point of the BOQ, and goes to a line by number. Line numbers count every line in order, collapsed or not.
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';

interface Position {
  line: number;
  sortKey: string;
  total: number;
}

const n = (v: number) => v.toLocaleString('en-IN');

export function PositionBar({
  boqId,
  topKey,
  onJump,
}: {
  boqId: string;
  /** The sort key of the line at the top of the view. */
  topKey: string | null;
  onJump: (sortKey: string) => void;
}) {
  const [pos, setPos] = useState<Position | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [goTo, setGoTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const url = `/api/tenant/boqs/${boqId}/position`;

  // Read once scrolling settles.
  useEffect(() => {
    if (!topKey) return;
    let live = true;
    const t = setTimeout(() => {
      void api
        .request<Position>(`${url}?key=${encodeURIComponent(topKey)}`)
        .then((p) => live && setPos(p))
        .catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [url, topKey]);

  const jump = async (line: number) => {
    setError(null);
    try {
      const p = await api.request<Position>(`${url}?line=${line}`);
      setPos(p);
      onJump(p.sortKey);
    } catch (err) {
      setError(describeError(err));
    }
  };
  const commit = () => {
    if (drag !== null) void jump(drag);
    setDrag(null);
  };

  if (!pos) return null;
  return (
    <div
      role="group"
      aria-label="Position in the BOQ"
      className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-2 px-3 py-1.5 text-xs text-fg-muted"
    >
      <span className="tabular-nums" data-testid="boq-position">
        Line {n(drag ?? pos.line)} of {n(pos.total)}
      </span>
      <input
        type="range"
        min={1}
        max={Math.max(1, pos.total)}
        value={drag ?? pos.line}
        aria-label="Slide to a point in the BOQ"
        className="min-w-[8rem] flex-1 accent-[var(--accent)]"
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => setDrag(null)}
      />
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const line = Number(goTo.replace(/[,\s]/g, ''));
          if (Number.isInteger(line) && line > 0) void jump(line).then(() => setGoTo(''));
        }}
      >
        <label htmlFor={`goto-${boqId}`}>Go to line</label>
        <input
          id={`goto-${boqId}`}
          inputMode="numeric"
          value={goTo}
          onChange={(e) => setGoTo(e.target.value)}
          className="w-24 rounded border border-line bg-surface px-1.5 py-0.5 text-fg tabular-nums"
        />
      </form>
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
