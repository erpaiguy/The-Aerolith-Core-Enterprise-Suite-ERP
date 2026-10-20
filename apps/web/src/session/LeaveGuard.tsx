// Leaving the app (docs/wave9-plan.md step 9a.4). Moving to another page or closing the tab with a form not saved
// asks first; closing the desktop app always asks, and says what would be lost: a form not saved, and site entries
// still waiting for signal (they stay on the device and go the next time this person signs in here).
import { useConfirm } from '@aerolith/ui';
import { useBlocker } from '@tanstack/react-router';
import { useEffect } from 'react';
import { hasUnsavedChanges, setUnsaved } from '../lib/unsaved';
import { usePending } from '../offline';
import { desktop } from '../platform';
import { useSession } from './session';

export function LeaveGuard() {
  const confirm = useConfirm();
  const session = useSession();
  const mine = usePending().filter((p) => !p.userId || p.userId === session.user?.id).length;

  useBlocker({
    // Only a move to another page: filters and tabs that change the address keep the form.
    shouldBlockFn: async ({ current, next }) => {
      if (!hasUnsavedChanges() || current.pathname === next.pathname) return false;
      const leave = await confirm({
        title: 'Leave without saving?',
        body: 'What you typed on this page has not been saved and will be lost.',
        confirmLabel: 'Leave without saving',
        cancelLabel: 'Stay on this page',
        tone: 'danger',
      });
      if (leave) setUnsaved(false);
      return !leave;
    },
    enableBeforeUnload: () => hasUnsavedChanges(),
  });

  useEffect(() => {
    const bridge = desktop();
    if (!bridge?.onCloseRequested || !bridge.setCloseGuard || !bridge.answerClose) return;
    void bridge.setCloseGuard(true);
    const off = bridge.onCloseRequested(() => {
      const losses = [
        hasUnsavedChanges() && 'the form on this page is not saved and will be lost',
        mine > 0 &&
          `${mine} site ${mine === 1 ? 'entry is' : 'entries are'} not sent yet; they stay on this computer and go the next time you sign in here`,
      ].filter(Boolean) as string[];
      void confirm({
        title: 'Close Aerolith Core?',
        body: losses.length
          ? `Before you go: ${losses.join('; and ')}.`
          : 'You stay signed in on this computer.',
        confirmLabel: 'Close',
        tone: losses.length ? 'danger' : 'primary',
      }).then((close) => bridge.answerClose!(close));
    });
    return () => {
      off();
      void bridge.setCloseGuard!(false);
    };
  }, [confirm, mine]);

  return null;
}
