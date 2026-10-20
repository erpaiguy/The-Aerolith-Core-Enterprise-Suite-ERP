// A person's own interface settings (docs/wave9-plan.md step 9a.5): favourites, recent pages, grid layouts. Read
// once after signing in, kept on the server so they follow the person to any device, and cached on this device so
// the app opens the same with no signal. Writes go to the server a moment after the last change.
import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { load, save } from './storage';

const CACHE_KEY = 'aerolith.prefs';
let user: string | null = null;
let values: Record<string, unknown> = {};
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const emit = () => {
  for (const l of listeners) l();
};
const cache = () => {
  if (user) save(`${CACHE_KEY}.${user}`, JSON.stringify(values));
};

/** Called when someone signs in (or the app resumes as them); null when nobody is signed in. */
export async function loadPrefs(userId: string | null) {
  user = userId;
  values = {};
  if (userId) {
    try {
      values = JSON.parse(load(`${CACHE_KEY}.${userId}`) ?? '{}') as Record<string, unknown>;
    } catch {
      values = {};
    }
  }
  emit();
  if (!userId) return;
  const fresh = await api
    .request<Record<string, unknown>>('/api/tenant/me/prefs')
    .catch(() => null);
  if (fresh && user === userId) {
    values = fresh;
    cache();
    emit();
  }
}

export function getPref<T>(key: string, fallback: T): T {
  return key in values ? (values[key] as T) : fallback;
}

export function setPref(key: string, value: unknown) {
  values = { ...values };
  if (value === null) delete values[key];
  else values[key] = value;
  cache();
  emit();
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void api
        .request(`/api/tenant/me/prefs/${encodeURIComponent(key)}`, {
          method: 'POST',
          body: { value },
        })
        .catch(() => undefined);
    }, 600),
  );
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** `const [cols, setCols] = usePref('grid.orders', defaults)` */
export function usePref<T>(key: string, fallback: T): [T, (v: T | null) => void] {
  const v = useSyncExternalStore(
    subscribe,
    () => values[key],
    () => values[key],
  );
  return [v === undefined ? fallback : (v as T), (next) => setPref(key, next)];
}
