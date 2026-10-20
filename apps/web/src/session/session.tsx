// Session state for the whole app: device activation (licence key → entitlement token), sign-in, and sign-out.
import { toast } from '@aerolith/ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from '../api/client';
import type {
  ActivationResult,
  Entitlement,
  LicenceState,
  LoginResult,
  Me,
  SessionUser,
} from '../api/types';
import { formatDateTime } from '../lib/format';
import { load, save } from '../lib/storage';
import { setUnsaved } from '../lib/unsaved';
import { outbox } from '../offline';
import { loadPrefs } from '../lib/prefs';
import { clientKind, desktop } from '../platform';

const ENTITLEMENT_KEY = 'aerolith.entitlement';
const DEVICE_KEY = 'aerolith.deviceId';
// The last signed-in user, so a reload with no signal still opens the app and its outbox (docs/wave6-plan.md step 4).
// The server still checks every request; this only decides what the screen shows while offline.
const LAST_USER_KEY = 'aerolith.lastUser';

function rememberUser(me: Me | null) {
  save(LAST_USER_KEY, me ? JSON.stringify(me) : null);
}

function lastUser(): Me | null {
  const raw = load(LAST_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Me;
  } catch {
    return null;
  }
}

export type SessionStatus = 'loading' | 'needs_activation' | 'signed_out' | 'signed_in';

interface SessionState {
  status: SessionStatus;
  entitlementToken: string | null;
  entitlement: Entitlement | null;
  user: SessionUser | null;
  mustChangePassword: boolean;
  /** Two-factor sign-in must be set up before anything else (step 8g.1). */
  mustSetUpMfa: boolean;
  licence: { state: LicenceState; featuresUnlocked: boolean } | null;
  /** Set when the stored licence is no longer usable (revoked, removed device). */
  licenceProblem: string | null;
}

interface SessionApi extends SessionState {
  activate(key: string): Promise<void>;
  signedIn(result: Extract<LoginResult, { status: 'ok' }>): Promise<void>;
  passwordChanged(accessToken: string): void;
  /** Two-factor sign-in was set up: a fresh token without the requirement. */
  mfaSetUp(): Promise<void>;
  /** The signed-in user changed their name. */
  renamed(displayName: string): void;
  /** `idle` when the session ended for want of activity: the notice says so. */
  signOut(reason?: 'idle'): Promise<void>;
  forgetDevice(): void;
}

/** Reads the entitlement payload for display. The server verifies the signature; the UI never trusts it for access. */
export function decodeEntitlement(token: string): Entitlement | null {
  const body = token.split('.')[1];
  if (!body) return null;
  try {
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as Entitlement;
  } catch {
    return null;
  }
}

async function deviceId(): Promise<string> {
  const bridge = desktop();
  if (bridge) return bridge.deviceId();
  let id = load(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    save(DEVICE_KEY, id);
  }
  return id;
}

const Ctx = createContext<SessionApi | null>(null);

const initial: SessionState = {
  status: 'loading',
  entitlementToken: null,
  entitlement: null,
  user: null,
  mustChangePassword: false,
  mustSetUpMfa: false,
  licence: null,
  licenceProblem: null,
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(initial);

  const setEntitlement = useCallback((token: string | null) => {
    save(ENTITLEMENT_KEY, token);
    setState((s) => ({
      ...s,
      entitlementToken: token,
      entitlement: token ? decodeEntitlement(token) : null,
    }));
  }, []);

  // Start-up: refresh the device's entitlement, then try to resume the session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = load(ENTITLEMENT_KEY);
      if (!stored) {
        if (!cancelled) setState({ ...initial, status: 'needs_activation' });
        return;
      }
      let token = stored;
      let problem: string | null = null;
      try {
        token = (
          await api.request<ActivationResult>('/api/licences/refresh', {
            method: 'POST',
            body: { token: stored },
            auth: false,
          })
        ).token;
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.code === 'licence_revoked' ||
            err.code === 'licence_suspended' ||
            err.code === 'device_revoked')
        ) {
          problem = err.code;
        } else if (err instanceof ApiError && err.status === 401) {
          save(ENTITLEMENT_KEY, null);
          if (!cancelled) setState({ ...initial, status: 'needs_activation' });
          return;
        }
        // Network errors: keep the cached token (the app may be briefly offline).
      }
      save(ENTITLEMENT_KEY, token);
      const base = {
        ...initial,
        entitlementToken: token,
        entitlement: decodeEntitlement(token),
        licenceProblem: problem,
      };
      let offline = false;
      const refreshed = problem
        ? null
        : await api.refresh().catch((err: unknown) => {
            offline = err instanceof ApiError && err.status === 0;
            return null;
          });
      if (!refreshed) {
        // No signal: resume as the last user; the first request after the signal returns refreshes the session, or
        // signs out if it is gone.
        const cached = offline ? lastUser() : null;
        if (cancelled) return;
        setState(
          cached
            ? {
                ...base,
                status: 'signed_in',
                user: cached,
                mustChangePassword: cached.mustChangePassword,
                licence: cached.licence,
              }
            : { ...base, status: 'signed_out' },
        );
        return;
      }
      const me = await api.request<Me>('/api/auth/me').catch(() => null);
      rememberUser(me);
      if (cancelled) return;
      setState(
        me
          ? {
              ...base,
              status: 'signed_in',
              user: me,
              mustChangePassword: me.mustChangePassword,
              mustSetUpMfa: !!me.mustSetUpMfa,
              licence: me.licence,
            }
          : { ...base, status: 'signed_out' },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Site entries kept on the device are sent only while the person who made them is signed in.
  const userId = state.status === 'signed_in' ? (state.user?.id ?? null) : null;
  useEffect(() => {
    outbox.setUser(userId);
    void loadPrefs(userId);
    if (userId && typeof navigator !== 'undefined' && navigator.onLine) void outbox.flush();
  }, [userId]);

  useEffect(() => {
    api.onSessionLost = () => {
      rememberUser(null);
      setState((s) => (s.status === 'signed_in' ? { ...s, status: 'signed_out', user: null } : s));
    };
  }, []);

  const value = useMemo<SessionApi>(
    () => ({
      ...state,
      async activate(key: string) {
        const bridge = desktop();
        const result = await api.request<ActivationResult>('/api/licences/activate', {
          method: 'POST',
          auth: false,
          body: {
            key,
            deviceId: await deviceId(),
            platform: bridge ? bridge.platform : 'browser',
            label: bridge ? 'Desktop app' : navigator.userAgent.slice(0, 100),
          },
        });
        setEntitlement(result.token);
        setState((s) => ({ ...s, status: 'signed_out', licenceProblem: null }));
      },
      async signedIn(result) {
        api.setAccessToken(result.accessToken);
        if (result.refreshToken) await desktop()?.setRefreshToken(result.refreshToken);
        rememberUser({
          ...result.user,
          mustChangePassword: result.mustChangePassword,
          licence: result.licence,
        });
        setState((s) => ({
          ...s,
          status: 'signed_in',
          user: result.user,
          mustChangePassword: result.mustChangePassword,
          mustSetUpMfa: !!result.mustSetUpMfa,
          licence: result.licence,
        }));
        void welcome(result.user.displayName);
      },
      async mfaSetUp() {
        await api.refresh();
        setState((s) => ({ ...s, mustSetUpMfa: false }));
      },
      passwordChanged(accessToken: string) {
        api.setAccessToken(accessToken);
        setState((s) => ({ ...s, mustChangePassword: false }));
      },
      renamed(displayName: string) {
        setState((s) => (s.user ? { ...s, user: { ...s.user, displayName } } : s));
      },
      async signOut(reason) {
        // Signing out is a choice to leave: no "unsaved changes" question on the way out.
        setUnsaved(false);
        await api.request('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
        rememberUser(null);
        api.setAccessToken(null);
        await desktop()?.setRefreshToken(null);
        setState((s) => ({
          ...s,
          status: 'signed_out',
          user: null,
          mustChangePassword: false,
          licence: null,
        }));
        if (reason === 'idle')
          toast.warning(
            'Signed out after a while without activity',
            'Sign in again to carry on. Anything not saved before then was not kept.',
            0,
          );
        else toast.success('Signed out', 'You can close this window, or sign in again below.');
      },
      forgetDevice() {
        setEntitlement(null);
        setState((s) => ({ ...s, status: 'needs_activation', user: null, licenceProblem: null }));
      },
    }),
    [state, setEntitlement],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The welcome after signing in (docs/wave9-plan.md step 9a.3): who, which company, and when and where they last
 * signed in, so a sign-in that was not theirs stands out.
 */
async function welcome(name: string) {
  const w = await api
    .request<{
      company: string | null;
      previous: { at: string; device: string; ip: string | null } | null;
    }>('/api/auth/welcome')
    .catch(() => null);
  const where = w?.previous
    ? `Last signed in ${formatDateTime(w.previous.at)} from ${w.previous.device}${
        w.previous.ip ? ` (${w.previous.ip})` : ''
      }. Not you? Change your password and tell your administrator.`
    : 'This is your first sign-in here.';
  toast.success(
    `Welcome, ${name}`,
    w?.company ? `${w.company}. ${where}` : where,
    w?.previous ? 8_000 : undefined,
  );
}

export function useSession(): SessionApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

export { clientKind };
