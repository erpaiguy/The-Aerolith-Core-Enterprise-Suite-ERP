// The header's Help menu (docs/wave9-plan.md step 9b.2): help for this page, the Help centre and its sections, and
// the legal terms. It also listens for "?" and F1 anywhere (not while typing in a field) to open the Help panel.
import { Link, useRouterState } from '@tanstack/react-router';
import { CircleHelp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { HelpPanel } from './HelpPanel';

/** True when a key press is typing: in a field, or already taken by the page (a grid starting an edit). */
export function isTyping(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

/** "?" or F1, with no Ctrl, Alt or Cmd, while not typing and with no other dialog open. */
export function isHelpKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key !== '?' && e.key !== 'F1') return false;
  if (isTyping(e)) return false;
  return !document.querySelector('dialog[open]');
}

export function HelpMenu() {
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState(false);
  const path = useRouterState({ select: (r) => r.location.pathname });
  const href = useRouterState({ select: (r) => r.location.href });
  useEffect(() => {
    setMenu(false);
    setPanel(false);
  }, [href]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isHelpKey(e)) return;
      e.preventDefault();
      setMenu(false);
      setPanel(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const item = 'block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-surface-2';
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={menu}
        aria-controls="help-menu"
        title="Help (? or F1)"
        onClick={() => setMenu(!menu)}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-2"
      >
        <CircleHelp className="size-4" aria-hidden /> Help
      </button>
      {menu ? (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={() => setMenu(false)} />
          <ul
            id="help-menu"
            aria-label="Help"
            className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-line bg-surface p-1 shadow-lg"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMenu(false);
            }}
          >
            <li>
              <button
                type="button"
                className={item}
                onClick={() => {
                  setMenu(false);
                  setPanel(true);
                }}
              >
                Help for this page
              </button>
            </li>
            <li>
              <Link to="/help" className={item}>
                Help centre
              </Link>
            </li>
            <li>
              <Link to="/help" search={{ section: 'shortcuts' }} className={item}>
                Keyboard shortcuts
              </Link>
            </li>
            <li>
              <Link to="/help" search={{ section: 'whats-new' }} className={item}>
                What’s new
              </Link>
            </li>
            <li>
              <Link to="/help" search={{ section: 'support', from: path }} className={item}>
                Get support
              </Link>
            </li>
            <li>
              <Link to="/help" search={{ section: 'legal' }} className={item}>
                Terms and privacy
              </Link>
            </li>
          </ul>
        </>
      ) : null}
      {panel ? <HelpPanel onClose={() => setPanel(false)} /> : null}
    </div>
  );
}
