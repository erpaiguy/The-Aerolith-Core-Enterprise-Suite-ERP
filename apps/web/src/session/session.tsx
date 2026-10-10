// Session state for the whole app: device activation (licence key → entitlement token), sign-in, and sign-out.
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
import { load, save } from '../lib/storage';
import { clientKind, desktop } from '../platform';

const ENTITLEMENT_KEY = 'aerolith.entitlement';
const DEVICE_KEY = 'aerolith.deviceId';

export type SessionStatus = 'loading' | 'needs_activation' | 'signed_out' | 'signed_in';

interface SessionState {
  status: SessionStatus;
  entitlementToken: string | null;
  entitlement: Entitlement | null;
  user: SessionUser | null;
  mustChangePassword: boolean;
  licence: { state: LicenceState; featuresUnlocked: boolean } | null;
  /** Set when the stored licence is no longer usable (revoked, removed device). */
  licenceProblem: string | null;
}

interface SessionApi extends SessionState {
  activate(key: string): Promise<void>;
  signedIn(result: Extract<LoginResult, { status: 'ok' }>): Promise<void>;
  passwordChanged(accessToken: string): void;
  /** The signed-in user changed their name. */
  renamed(displayName: string): void;
  signOut(): Promise<void>;
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
      const refreshed = problem ? null : await api.refresh().catch(() => null);
      if (!refreshed) {
        if (!cancelled) setState({ ...base, status: 'signed_out' });
        return;
      }
      const me = await api.request<Me>('/api/auth/me').catch(() => null);
      if (cancelled) return;
      setState(
        me
          ? {
              ...base,
              status: 'signed_in',
              user: me,
              mustChangePassword: me.mustChangePassword,
              licence: me.licence,
            }
          : { ...base, status: 'signed_out' },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    api.onSessionLost = () =>
      setState((s) => (s.status === 'signed_in' ? { ...s, status: 'signed_out', user: null } : s));
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
        setState((s) => ({
          ...s,
          status: 'signed_in',
          user: result.user,
          mustChangePassword: result.mustChangePassword,
          licence: result.licence,
        }));
      },
      passwordChanged(accessToken: string) {
        api.setAccessToken(accessToken);
        setState((s) => ({ ...s, mustChangePassword: false }));
      },
      renamed(displayName: string) {
        setState((s) => (s.user ? { ...s, user: { ...s.user, displayName } } : s));
      },
      async signOut() {
        await api.request('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
        api.setAccessToken(null);
        await desktop()?.setRefreshToken(null);
        setState((s) => ({
          ...s,
          status: 'signed_out',
          user: null,
          mustChangePassword: false,
          licence: null,
        }));
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

export function useSession(): SessionApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

export { clientKind };
