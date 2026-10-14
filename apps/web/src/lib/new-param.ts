// The header's "New" menu (docs/wave7-plan.md step 7a.5) opens a screen with `?new=<form>`: the screen opens that
// create form, scrolls to it and puts the cursor in its first field.
import { useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';

/** Whether the screen was opened to create `key` (`?new=key`). */
export function useNewParam(key: string): boolean {
  const asked = useRouterState({
    select: (r) => {
      const v = (r.location.search as { new?: unknown }).new;
      return typeof v === 'string' ? v : null;
    },
  });
  return asked === key;
}

/** Once the form labelled `label` is drawn (data may still be loading), bring it into view and focus it. */
export function useFocusForm(label: string, when: boolean) {
  useEffect(() => {
    if (!when) return;
    let tries = 0;
    const timer = setInterval(() => {
      const form = document.querySelector<HTMLFormElement>(`form[aria-label="${label}"]`);
      if (!form && ++tries < 50) return;
      clearInterval(timer);
      form?.scrollIntoView({ block: 'center' });
      form
        ?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select, textarea')
        ?.focus();
    }, 100);
    return () => clearInterval(timer);
  }, [label, when]);
}
