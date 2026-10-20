// The offline outbox (docs/wave6-plan.md step 4): site forms saved on the phone when there is no signal, each with an
// idempotency key made here, and sent in order once there is signal. The server keeps each key's first success and
// returns it to repeats, so a retry never posts twice. The first refusal stops the queue and stays, with its reason,
// until the person fixes or discards it, so nothing is sent out of order behind it.

export interface Pending {
  id: string;
  /** What it is, for the Outbox page: "Goods receipt for PO/2026-27/0004". */
  label: string;
  path: string;
  body: unknown;
  key: string;
  createdAt: number;
  error: string | null;
  /** Who made it: sent only while they are signed in, never under the next person on a shared device. */
  userId?: string | null;
}

/** Where pending items live: IndexedDB in the browser, a Map in tests. */
export interface Store {
  all(): Promise<Pending[]>;
  put(p: Pending): Promise<void>;
  remove(id: string): Promise<void>;
}

export type Send = (
  path: string,
  body: unknown,
  key: string,
) => Promise<{ ok: true } | { ok: false; offline: boolean; message: string }>;

export const newKey = () => {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

export class Outbox {
  private flushing: Promise<{ sent: number; stopped: string | null }> | null = null;
  private listeners = new Set<() => void>();
  private user: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly send: Send,
  ) {}

  /** The person signed in on this device now (null when nobody is). */
  setUser(id: string | null) {
    this.user = id;
  }

  onChange(f: () => void) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  private changed() {
    for (const f of this.listeners) f();
  }

  async list() {
    return (await this.store.all()).sort((a, b) => a.createdAt - b.createdAt);
  }

  async add(label: string, path: string, body: unknown, key = newKey()) {
    const p: Pending = {
      id: key,
      label,
      path,
      body,
      key,
      createdAt: Date.now(),
      error: null,
      userId: this.user,
    };
    await this.store.put(p);
    this.changed();
    return p;
  }

  async discard(id: string) {
    await this.store.remove(id);
    this.changed();
  }

  /**
   * Sends what the signed-in person left waiting, oldest first; stops when offline again or at the first refusal.
   * Someone else's entries wait for them to sign in on this device again.
   */
  flush() {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush() {
    let sent = 0;
    for (const p of await this.list()) {
      if (p.userId && p.userId !== this.user) continue;
      const r = await this.send(p.path, p.body, p.key);
      if (r.ok) {
        await this.store.remove(p.id);
        sent++;
        this.changed();
        continue;
      }
      if (!r.offline) {
        await this.store.put({ ...p, error: r.message });
        this.changed();
        return { sent, stopped: p.id };
      }
      return { sent, stopped: null };
    }
    return { sent, stopped: null };
  }
}

/** IndexedDB, one object store, keyed by id. */
export function indexedDbStore(name = 'aerolith-outbox'): Store {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pending', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const tx = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const req = f(db.transaction('pending', mode).objectStore('pending'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).finally(() => db.close());
  };
  return {
    all: () => tx<Pending[]>('readonly', (s) => s.getAll() as IDBRequest<Pending[]>),
    put: async (p) => {
      await tx('readwrite', (s) => s.put(p));
    },
    remove: async (id) => {
      await tx('readwrite', (s) => s.delete(id));
    },
  };
}
