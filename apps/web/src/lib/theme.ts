// Light, dark, or as the computer is set (docs/wave9-plan.md step 9b.1), kept on this device and applied before the
// first paint so the app never flashes the wrong colours. The tokens in packages/ui/src/tokens.css do the rest.
import { load, save } from './storage';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'aerolith.theme';

export function theme(): Theme {
  const v = load(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyTheme(t: Theme = theme()) {
  if (typeof document === 'undefined') return;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme) {
  save(KEY, t === 'system' ? null : t);
  applyTheme(t);
}
