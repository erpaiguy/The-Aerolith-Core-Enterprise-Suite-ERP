import { describe, expect, it } from 'vitest';
import { Outbox, type Pending, type Send, type Store } from './outbox';

function memory(): Store & { items: Map<string, Pending> } {
  const items = new Map<string, Pending>();
  return {
    items,
    all: async () => [...items.values()],
    put: async (p) => void items.set(p.id, p),
    remove: async (id) => void items.delete(id),
  };
}

describe('the offline outbox', () => {
  it('sends oldest first with each one’s own key, and empties', async () => {
    const store = memory();
    const seen: string[] = [];
    const send: Send = async (path, _b, key) => {
      seen.push(`${path} ${key}`);
      return { ok: true };
    };
    const box = new Outbox(store, send);
    await box.add('A', '/a', {}, 'k'.repeat(16) + '1');
    await new Promise((r) => setTimeout(r, 2));
    await box.add('B', '/b', {}, 'k'.repeat(16) + '2');
    expect(await box.flush()).toEqual({ sent: 2, stopped: null });
    expect(seen).toEqual([`/a ${'k'.repeat(16)}1`, `/b ${'k'.repeat(16)}2`]);
    expect(store.items.size).toBe(0);
  });

  it('stops at the first refusal and keeps it with its reason; nothing behind it is sent', async () => {
    const store = memory();
    const sent: string[] = [];
    const box = new Outbox(store, async (path) => {
      sent.push(path);
      return path === '/bad'
        ? { ok: false, offline: false, message: 'Over the ordered quantity' }
        : { ok: true };
    });
    await box.add('bad', '/bad', {});
    await new Promise((r) => setTimeout(r, 2));
    await box.add('good', '/good', {});
    const r = await box.flush();
    expect(r.sent).toBe(0);
    expect(sent).toEqual(['/bad']);
    expect((await box.list()).map((p) => [p.label, p.error])).toEqual([
      ['bad', 'Over the ordered quantity'],
      ['good', null],
    ]);
    await box.discard(r.stopped!);
    expect(await box.flush()).toEqual({ sent: 1, stopped: null });
  });

  it('keeps everything when the signal goes again, and flushes once at a time', async () => {
    const store = memory();
    let calls = 0;
    const box = new Outbox(store, async () => {
      calls++;
      return { ok: false, offline: true, message: 'network' };
    });
    await box.add('A', '/a', {});
    const [a, b] = await Promise.all([box.flush(), box.flush()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(store.items.size).toBe(1);
  });

  it('sends a person’s entries only while they are signed in, never under the next person', async () => {
    const store = memory();
    const seen: string[] = [];
    const box = new Outbox(store, async (path) => {
      seen.push(path);
      return { ok: true };
    });
    box.setUser('ravi');
    await box.add('Ravi’s receipt', '/ravi', {});
    box.setUser('sunita');
    await box.add('Sunita’s report', '/sunita', {});
    expect(await box.flush()).toEqual({ sent: 1, stopped: null });
    expect(seen).toEqual(['/sunita']);
    box.setUser('ravi');
    await box.flush();
    expect(seen).toEqual(['/sunita', '/ravi']);
    expect(store.items.size).toBe(0);
  });
});
