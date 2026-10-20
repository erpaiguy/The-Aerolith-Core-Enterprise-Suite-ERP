// Unsaved changes (docs/wave9-plan.md step 9a.4): typing in a form marks the page, a save clears it, a refused save
// keeps it, a filter form clears itself, and search boxes never count.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import { countsAsEdit, hasUnsavedChanges, setUnsaved, watchForEdits } from './unsaved';

const type = (el: HTMLElement) => el.dispatchEvent(new Event('input', { bubbles: true }));
const page = (html: string) => {
  document.body.innerHTML = html;
  return (sel: string) => document.querySelector<HTMLElement>(sel)!;
};
const answering = (status: number) =>
  new ApiClient(
    async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
  );

beforeAll(() => watchForEdits());
afterEach(() => {
  setUnsaved(false);
  vi.useRealTimers();
});

describe('unsaved changes', () => {
  it('typing in a form marks the page; a save clears it', async () => {
    const $ = page('<form><input name="qty"></form>');
    type($('input'));
    expect(hasUnsavedChanges()).toBe(true);
    await answering(200).request('/api/tenant/x', { method: 'POST', body: {} });
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a refused save keeps the mark; reading never clears it', async () => {
    const $ = page('<form><textarea></textarea></form>');
    type($('textarea'));
    await answering(409)
      .request('/api/tenant/x', { method: 'POST', body: {} })
      .catch(() => null);
    await answering(200).request('/api/tenant/x');
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('a filter form that saves nothing clears itself', () => {
    vi.useFakeTimers();
    const $ = page('<form><input type="date"><button>Show</button></form>');
    type($('input'));
    $('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(1_600);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('search boxes, fields outside forms and opted-out areas never count', () => {
    const $ = page(
      '<form><input type="search" id="s"><div data-no-unsaved><input id="o"></div></form><input id="loose">',
    );
    expect(countsAsEdit($('#s'))).toBe(false);
    expect(countsAsEdit($('#o'))).toBe(false);
    expect(countsAsEdit($('#loose'))).toBe(false);
  });
});
