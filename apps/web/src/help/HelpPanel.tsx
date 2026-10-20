// The Help panel (docs/wave9-plan.md step 9b.2), opened by the Help menu, "?" or F1: the help of the current page, a
// search over every topic (arrow keys move through the results, Enter opens one), and related topics.
import { Dialog } from '@aerolith/ui';
import { Link, useRouterState } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { paramsOf, searchTopics, topicFor } from './lookup';
import type { HelpTopic } from './topics';
import { TopicView } from './TopicView';

export function HelpPanel({ onClose }: { onClose: () => void }) {
  const path = useRouterState({ select: (r) => r.location.pathname });
  const current = topicFor(path);
  const params = current ? paramsOf(current.route, path) : {};
  const [shown, setShown] = useState<HelpTopic | null>(current);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const results = text.trim() ? searchTopics(text) : [];
  useEffect(() => setActive(0), [text]);
  const open = (t: HelpTopic) => {
    setShown(t);
    setText('');
  };
  return (
    <Dialog open onClose={onClose} title="Help" size="lg">
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-md border border-line px-3">
          <Search className="size-4 text-fg-muted" aria-hidden />
          <input
            ref={input}
            type="search"
            aria-label="Search help"
            aria-controls="help-results"
            placeholder="Search help: a screen or a task…"
            className="w-full bg-transparent py-2 text-sm outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && results[active]) {
                e.preventDefault();
                open(results[active].topic);
              }
            }}
          />
        </div>
        {text.trim() ? (
          <ul
            id="help-results"
            aria-label="Help topics found"
            className="max-h-[50vh] overflow-y-auto"
          >
            {results.map((r, i) => (
              <li key={r.topic.route}>
                <button
                  type="button"
                  onClick={() => open(r.topic)}
                  onMouseEnter={() => setActive(i)}
                  aria-current={i === active ? 'true' : undefined}
                  className={`flex w-full items-baseline gap-3 rounded px-3 py-2 text-left text-sm ${i === active ? 'bg-surface-2' : ''}`}
                >
                  <span className="font-medium">{r.topic.title}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                    {r.topic.group}
                  </span>
                </button>
              </li>
            ))}
            {!results.length ? (
              <li className="px-3 py-6 text-center text-sm text-fg-muted">
                No help found. Try other words, or ask support from the Help centre.
              </li>
            ) : null}
          </ul>
        ) : shown ? (
          <>
            {shown !== current && current ? (
              <button
                type="button"
                onClick={() => setShown(current)}
                className="text-sm text-accent underline"
              >
                Back to help for this page
              </button>
            ) : null}
            <TopicView topic={shown} params={params} onOpen={open} goTo={shown !== current} />
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            There is no help written for this page yet. Search above, or open the Help centre.
          </p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-sm">
          <Link to="/help" className="text-accent underline">
            Help centre
          </Link>
          <Link to="/help" search={{ section: 'shortcuts' }} className="text-accent underline">
            Keyboard shortcuts
          </Link>
          <Link
            to="/help"
            search={{ section: 'support', from: path }}
            className="text-accent underline"
          >
            Get support
          </Link>
        </div>
      </div>
    </Dialog>
  );
}
