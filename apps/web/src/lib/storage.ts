// Per-device conveniences only (entitlement token, device id, last username). Storage can be unavailable (private
// windows, blocked site data), so every access is guarded and the app still works without it.
export function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // ignore: the session continues in memory
  }
}
