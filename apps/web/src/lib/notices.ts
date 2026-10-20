// Pop-up notices (docs/wave9-plan.md step 9a.2), on unless the person turns them off for this device in Settings:
// some prefer a quiet screen, and what failed is always also said on the page itself or in the error dialog.
import { load, save } from './storage';

const KEY = 'aerolith.toasts';

export const noticesOn = () => load(KEY) !== 'off';

/** Takes effect when the app next opens (the notices area is set up once at start). */
export function setNoticesOn(on: boolean) {
  save(KEY, on ? null : 'off');
}
