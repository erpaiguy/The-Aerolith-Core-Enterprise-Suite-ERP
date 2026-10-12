// The app's outbox (docs/wave6-plan.md step 4): forms that must reach the server once, sent with an idempotency key;
// with no signal they wait on the phone and go when it returns (on the browser's "online", and every 30 seconds).
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import { describeError } from '../lib/format';
import { Outbox, indexedDbStore, newKey, type Pending } from './outbox';

export const outbox = new Outbox(indexedDbStore(), async (path, body, key) => {
  try {
    await api.request(path, { method: 'POST', body, idempotencyKey: key });
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 0)
      return { ok: false, offline: true, message: 'No signal' };
    return { ok: false, offline: false, message: describeError(err) };
  }
});

/** Sends a form now, or keeps it on the phone when there is no signal. A refusal is thrown as usual. */
export async function sendOrKeep<T>(
  label: string,
  path: string,
  body: unknown,
): Promise<{ queued: false; result: T } | { queued: true; pending: Pending }> {
  const key = newKey();
  if (typeof navigator !== 'undefined' && !navigator.onLine)
    return { queued: true, pending: await outbox.add(label, path, body, key) };
  try {
    return {
      queued: false,
      result: await api.request<T>(path, { method: 'POST', body, idempotencyKey: key }),
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 0)
      return { queued: true, pending: await outbox.add(label, path, body, key) };
    throw err;
  }
}

let started = false;
/** Starts sending in the background: when the signal returns, and every 30 seconds. */
export function startOutbox() {
  if (started || typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  started = true;
  window.addEventListener('online', () => void outbox.flush());
  setInterval(() => {
    if (navigator.onLine) void outbox.flush();
  }, 30_000);
  if (navigator.onLine) void outbox.flush();
}

/** What is waiting, live. */
export function usePending() {
  const [items, setItems] = useState<Pending[]>([]);
  useEffect(() => {
    if (typeof indexedDB === 'undefined') return;
    const load = () => void outbox.list().then(setItems, () => setItems([]));
    load();
    const off = outbox.onChange(load);
    return () => {
      off();
    };
  }, []);
  return items;
}
