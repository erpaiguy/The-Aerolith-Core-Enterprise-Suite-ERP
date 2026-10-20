// Before an idle session ends (docs/wave9-plan.md step 9a.3). The server ends a session that has not been refreshed
// for 30 minutes in a browser (12 hours in the desktop app). Activity here keeps it alive, so someone typing a long
// form is never thrown out mid-sentence; two minutes before the end of real idleness a dialog offers to stay, and at
// the end the app signs out itself and says why. Activity in another tab of the app counts too.
import { Button, Dialog } from '@aerolith/ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { load, save } from '../lib/storage';
import { clientKind } from '../platform';
import { useSession } from './session';

const ACTIVITY_KEY = 'aerolith.activity';
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
/** Keep the server's session in step with activity, at most this often. */
const REFRESH_EVERY_MS = 10 * 60_000;

export function IdleGuard({
  idleMs = clientKind() === 'desktop' ? 12 * 3_600_000 : 30 * 60_000,
  warnMs = 2 * 60_000,
}: {
  idleMs?: number;
  warnMs?: number;
}) {
  const session = useSession();
  const signedIn = session.status === 'signed_in';
  const last = useRef(Date.now());
  const lastRefresh = useRef(Date.now());
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    last.current = Date.now();
    lastRefresh.current = Date.now();
    let lastSaved = 0;
    const mark = () => {
      const now = Date.now();
      last.current = now;
      if (now - lastSaved > 15_000) {
        lastSaved = now;
        save(ACTIVITY_KEY, String(now));
      }
      if (now - lastRefresh.current > REFRESH_EVERY_MS) {
        lastRefresh.current = now;
        void api.refresh().catch(() => null);
      }
    };
    const other = (e: StorageEvent) => {
      if (e.key === ACTIVITY_KEY && e.newValue)
        last.current = Math.max(last.current, Number(e.newValue));
    };
    for (const e of EVENTS) window.addEventListener(e, mark, { passive: true });
    window.addEventListener('storage', other);
    const tick = setInterval(() => {
      const shared = Number(load(ACTIVITY_KEY) ?? 0);
      if (shared > last.current) last.current = shared;
      const remaining = idleMs - (Date.now() - last.current);
      if (remaining <= 0) {
        setLeft(null);
        void session.signOut('idle');
      } else setLeft(remaining <= warnMs ? remaining : null);
    }, 1_000);
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, mark);
      window.removeEventListener('storage', other);
      clearInterval(tick);
    };
    // Restarts only on sign-in and sign-out; signOut reads no state, so the first one seen is as good as any.
  }, [signedIn, idleMs, warnMs]);

  const stay = () => {
    last.current = Date.now();
    lastRefresh.current = Date.now();
    save(ACTIVITY_KEY, String(last.current));
    setLeft(null);
    void api.refresh().catch(() => null);
  };

  if (!signedIn || left === null) return null;
  const s = Math.ceil(left / 1000);
  return (
    <Dialog
      open
      onClose={stay}
      dismissable={false}
      role="alertdialog"
      size="sm"
      title="Are you still there?"
      description={`For safety you will be signed out in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} unless you carry on.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => void session.signOut()}>
            Sign out now
          </Button>
          <Button autoFocus onClick={stay}>
            Stay signed in
          </Button>
        </>
      }
    />
  );
}
