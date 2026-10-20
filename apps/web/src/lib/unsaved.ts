// Unsaved changes (docs/wave9-plan.md step 9a.4), noticed without each of 175 screens having to say so: typing into a
// form marks the page unsaved; a successful save (any request that changes something), or moving to another page
// the person agreed to leave for, marks it clean. Search boxes, filters outside forms and inputs marked
// `data-no-unsaved` (or inside such an element) never count. A screen that knows better can say so with
// `setUnsaved`. Leaving with unsaved changes asks first: another page in the app, closing the tab, or closing the
// desktop app.

let dirty = false;
const listeners = new Set<() => void>();

export const hasUnsavedChanges = () => dirty;

export function setUnsaved(value: boolean) {
  if (dirty === value) return;
  dirty = value;
  for (const l of listeners) l();
}

export function onUnsavedChange(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const SKIP_TYPES = new Set(['search', 'button', 'submit', 'reset', 'hidden']);

/** True for an edit that should count: a field inside a form, not a search box or an opted-out area. */
export function countsAsEdit(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (!(
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ))
    return false;
  if (target instanceof HTMLInputElement && SKIP_TYPES.has(target.type)) return false;
  if (target.closest('[data-no-unsaved]')) return false;
  return target.closest('form') !== null;
}

// A submit that starts no save within this long was a filter or a search, not a form to keep.
const FILTER_GRACE_MS = 1_500;
let submitted: ReturnType<typeof setTimeout> | null = null;

/** The API client calls this when a request that changes something starts. */
export function saveStarted() {
  if (submitted !== null) clearTimeout(submitted);
  submitted = null;
}

let watching = false;
/** Starts noticing edits; called once at start-up. */
export function watchForEdits() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener(
    'input',
    (e) => {
      if (countsAsEdit(e.target)) setUnsaved(true);
    },
    true,
  );
  // A form put back as it was is not unsaved. A submit is judged by the request it makes: a save clears the mark when
  // it succeeds (and keeps it when refused); no save at all means it was a filter.
  document.addEventListener('reset', () => setUnsaved(false), true);
  document.addEventListener(
    'submit',
    () => {
      if (submitted !== null) clearTimeout(submitted);
      submitted = setTimeout(() => {
        submitted = null;
        setUnsaved(false);
      }, FILTER_GRACE_MS);
    },
    true,
  );
}
