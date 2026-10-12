// Mark-up (docs/wave5-plan.md step 2): a PDF drawn page by page in this browser with pdf.js (Apache-2.0, loaded only
// here), from the bytes the user may already download, so the server renders nothing. Drag on a page to draw a box
// and comment on it; numbered pins show the comments, listed beside with replies, resolve and reopen. Boxes are kept
// as fractions of the page, so they land in the same place at any size.
import { Alert, Badge, Button, Spinner, Textarea } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { api } from '../../api/client';
import { describeError } from '../../lib/format';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Markup {
  id: string;
  number: number;
  review: string | null;
  page: number;
  box: Box | null;
  body: string;
  author: string;
  createdAt: string;
  status: 'open' | 'resolved';
  resolvedBy: string | null;
  mayResolve: boolean;
  replies: { id: string; body: string; author: string; createdAt: string }[];
}

const WIDTH = 760;
const MAX_PAGES = 60;

export function MarkupViewer({
  documentId,
  versionNo,
  reviewId,
  mayAdd,
}: {
  documentId: string;
  versionNo: number;
  /** New comments join this review. */
  reviewId: string | null;
  /** Off once the review is closed: its comments are answered, not added to. */
  mayAdd: boolean;
}) {
  const qc = useQueryClient();
  const key = ['markups', documentId, versionNo];
  const marks = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Markup[]>(`/api/tenant/documents/${documentId}/versions/${versionNo}/markups`),
  });
  const pdf = useQuery({
    queryKey: ['markup-pdf', documentId, versionNo],
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async () => {
      const { blob } = await api.download(
        `/api/tenant/documents/${documentId}/file?version=${versionNo}`,
      );
      const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
      if (String.fromCharCode(...head) !== '%PDF-') return null;
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs.getDocument({
        data: new Uint8Array(await blob.arrayBuffer()),
        isEvalSupported: false,
      }).promise;
    },
  });
  const [draft, setDraft] = useState<{ page: number; box: Box | null } | null>(null);
  const [text, setText] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const call = async (path: string, body: object) => {
    setError(null);
    try {
      await api.request(path, { method: 'POST', body });
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['reviews'] });
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const pages = pdf.data ? Math.min(pdf.data.numPages, MAX_PAGES) : 0;
  const list = marks.data ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-3 overflow-x-auto">
        {pdf.isPending ? (
          <Spinner label="Opening the document" />
        ) : pdf.isError ? (
          <Alert tone="danger">{describeError(pdf.error)}</Alert>
        ) : pdf.data === null ? (
          <p className="text-sm text-fg-muted">
            Not a PDF: comments go on the document as a whole.
          </p>
        ) : (
          <>
            {pdf.data!.numPages > MAX_PAGES && (
              <p className="text-xs text-fg-muted">The first {MAX_PAGES} pages are shown.</p>
            )}
            {Array.from({ length: pages }, (_, i) => (
              <Page
                key={i + 1}
                doc={pdf.data!}
                n={i + 1}
                marks={list.filter((m) => m.page === i + 1 && m.box)}
                draft={draft?.page === i + 1 ? draft.box : null}
                active={active}
                onPick={setActive}
                onBox={
                  mayAdd
                    ? (box) => {
                        setDraft({ page: i + 1, box });
                        setText('');
                      }
                    : null
                }
              />
            ))}
          </>
        )}
      </div>
      <aside className="space-y-3" aria-label="Comments">
        {error && <Alert tone="danger">{error}</Alert>}
        {mayAdd && !draft && (
          <p className="text-xs text-fg-muted">
            Drag on a page to mark an area, or{' '}
            <button
              type="button"
              className="underline"
              onClick={() => {
                setDraft({ page: 0, box: null });
                setText('');
              }}
            >
              write a general comment
            </button>
            .
          </p>
        )}
        {draft && (
          <form
            aria-label="New comment"
            className="space-y-2 rounded border border-border p-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await call(`/api/tenant/documents/${documentId}/versions/${versionNo}/markups`, {
                  reviewId,
                  page: draft.page,
                  box: draft.box,
                  body: text,
                })
              )
                setDraft(null);
            }}
          >
            <p className="text-xs text-fg-muted">
              {draft.page === 0 ? 'General comment' : `Page ${draft.page}, the marked area`}
            </p>
            <Textarea
              aria-label="Comment"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              required
              autoFocus
            />
            <div className="flex gap-2">
              <Button type="submit">Add comment</Button>
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {marks.isPending && <Spinner />}
        <ol className="space-y-2">
          {list.map((m) => (
            <Comment
              key={m.id}
              m={m}
              active={active === m.id}
              onPick={() => setActive(m.id)}
              call={call}
            />
          ))}
        </ol>
        {list.length === 0 && !marks.isPending && (
          <p className="text-sm text-fg-muted">No comments yet.</p>
        )}
      </aside>
    </div>
  );
}

type PdfDoc = PDFDocumentProxy;

function Page({
  doc,
  n,
  marks,
  draft,
  active,
  onPick,
  onBox,
}: {
  doc: PdfDoc;
  n: number;
  marks: Markup[];
  draft: Box | null;
  active: string | null;
  onPick: (id: string) => void;
  onBox: ((b: Box) => void) | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  useEffect(() => {
    let task: { cancel: () => void } | null = null;
    let gone = false;
    void doc.getPage(n).then(async (page) => {
      if (gone || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: WIDTH / base.width });
      const c = canvas.current;
      c.width = Math.ceil(viewport.width);
      c.height = Math.ceil(viewport.height);
      setSize({ w: c.width, h: c.height });
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      const r = page.render({ canvas: c, canvasContext: ctx, viewport });
      task = r;
      await r.promise.catch(() => {});
    });
    return () => {
      gone = true;
      task?.cancel();
    };
  }, [doc, n]);
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const shown = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        w: Math.abs(drag.x1 - drag.x0),
        h: Math.abs(drag.y1 - drag.y0),
      }
    : draft;
  const pct = (b: Box) => ({
    left: `${b.x * 100}%`,
    top: `${b.y * 100}%`,
    width: `${b.w * 100}%`,
    height: `${b.h * 100}%`,
  });
  return (
    <figure className="relative w-fit border border-border bg-white" style={{ width: WIDTH }}>
      <canvas ref={canvas} className="block" style={{ width: WIDTH }} />
      {size && (
        <div
          role="application"
          aria-label={`Page ${n}`}
          className={`absolute inset-0 ${onBox ? 'cursor-crosshair' : ''}`}
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => {
            if (!onBox || e.target !== e.currentTarget) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = at(e);
            setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }}
          onPointerMove={(e) => {
            if (drag) {
              const p = at(e);
              setDrag({ ...drag, x1: p.x, y1: p.y });
            }
          }}
          onPointerUp={() => {
            if (!drag || !onBox) return;
            const b = shown!;
            setDrag(null);
            if (b.w > 0.01 && b.h > 0.01) onBox(b);
          }}
        >
          {marks.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-label={`Comment ${m.number}`}
              onClick={() => onPick(m.id)}
              className={`absolute border-2 ${
                m.status === 'resolved' ? 'border-success/60' : 'border-danger'
              } ${active === m.id ? 'bg-warning/25' : 'bg-warning/10'}`}
              style={pct(m.box!)}
            >
              <span className="absolute -left-2 -top-3 rounded-full bg-danger px-1.5 text-xs text-white">
                {m.number}
              </span>
            </button>
          ))}
          {shown && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-accent bg-accent/10"
              style={pct(shown)}
            />
          )}
        </div>
      )}
      <figcaption className="absolute bottom-1 right-2 text-xs text-fg-muted">Page {n}</figcaption>
    </figure>
  );
}

function Comment({
  m,
  active,
  onPick,
  call,
}: {
  m: Markup;
  active: boolean;
  onPick: () => void;
  call: (path: string, body: object) => Promise<boolean>;
}) {
  const [reply, setReply] = useState('');
  return (
    <li
      aria-label={`Comment ${m.number}`}
      className={`rounded border p-2 text-sm ${active ? 'border-accent' : 'border-border'}`}
      onClick={onPick}
    >
      <p>
        <span className="font-medium">
          {m.number}. {m.author}
        </span>{' '}
        <span className="text-xs text-fg-muted">
          {m.page === 0 ? 'general' : `page ${m.page}`}
          {m.review && ` · ${m.review}`}
        </span>{' '}
        <Badge tone={m.status === 'resolved' ? 'success' : 'warning'}>{m.status}</Badge>
      </p>
      <p className="whitespace-pre-wrap">{m.body}</p>
      {m.replies.map((r) => (
        <p key={r.id} className="ml-3 mt-1 whitespace-pre-wrap border-l-2 border-border pl-2">
          <span className="font-medium">{r.author}:</span> {r.body}
        </p>
      ))}
      <form
        aria-label={`Reply to comment ${m.number}`}
        className="mt-2 flex gap-1"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call(`/api/tenant/markups/${m.id}/replies`, { body: reply })) setReply('');
        }}
      >
        <Textarea
          aria-label="Reply"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={1}
          required
        />
        <Button type="submit" variant="secondary">
          Reply
        </Button>
      </form>
      {m.mayResolve && (
        <Button
          type="button"
          variant="ghost"
          className="mt-1"
          onClick={() =>
            void call(`/api/tenant/markups/${m.id}/status`, {
              status: m.status === 'open' ? 'resolved' : 'open',
            })
          }
        >
          {m.status === 'open' ? 'Resolve' : 'Reopen'}
        </Button>
      )}
    </li>
  );
}
