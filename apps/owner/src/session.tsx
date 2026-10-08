// Operator session: resume from the refresh cookie at start-up, sign in, sign out.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type Operator } from './api';

export type SessionStatus = 'loading' | 'signed_out' | 'signed_in';

interface SessionState {
  status: SessionStatus;
  operator: Operator | null;
  mustChangePassword: boolean;
}

interface SessionApi extends SessionState {
  /** Writes are allowed for the `owner` role only (the API enforces this too). */
  canWrite: boolean;
  signedIn(result: { accessToken: string; mustChangePassword: boolean }): Promise<void>;
  passwordChanged(accessToken: string): void;
  signOut(): Promise<void>;
}

const Ctx = createContext<SessionApi | null>(null);
const signedOut: SessionState = { status: 'signed_out', operator: null, mustChangePassword: false };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ ...signedOut, status: 'loading' });

  const load = useCallback(async (mustChangePassword: boolean) => {
    const operator = await api.get<Operator>('/api/owner/me').catch(() => null);
    setState(operator ? { status: 'signed_in', operator, mustChangePassword } : signedOut);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.refresh().then(async (s) => {
      if (cancelled) return;
      if (!s) return setState(signedOut);
      await load(s.mustChangePassword);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    api.onSessionLost = () => setState(signedOut);
  }, []);

  const value = useMemo<SessionApi>(
    () => ({
      ...state,
      canWrite: state.operator?.role === 'owner',
      async signedIn(result) {
        api.setAccessToken(result.accessToken);
        await load(result.mustChangePassword);
      },
      passwordChanged(accessToken) {
        api.setAccessToken(accessToken);
        setState((s) => ({ ...s, mustChangePassword: false }));
      },
      async signOut() {
        await api.post('/api/owner/auth/logout').catch(() => undefined);
        api.setAccessToken(null);
        setState(signedOut);
      },
    }),
    [state, load],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
