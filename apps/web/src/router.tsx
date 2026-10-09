import {
  Navigate,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from '@tanstack/react-router';
import { useSession } from './session/session';
import { ResetRequestsScreen, UsersScreen } from './screens/Admin';
import { ActivateScreen } from './screens/Activate';
import { AppShell } from './screens/AppShell';
import { HomeScreen } from './screens/Home';
import { ChangePasswordScreen, ForgotScreen, SetPasswordScreen } from './screens/Passwords';
import { SignInScreen } from './screens/SignIn';
import { BoqScreen } from './screens/Boq';
import { ClientsScreen } from './screens/Clients';
import { DocumentsScreen } from './screens/Documents';
import { BoqPricingScreen } from './screens/Pricing';
import { BoqVersionsScreen } from './screens/Versions';
import { AnalysisEditor, RateAnalysesScreen } from './screens/RateAnalyses';
import { ResourcesScreen } from './screens/Resources';
import { RfqScreen } from './screens/Rfq';
import { TenderDetailScreen } from './screens/TenderDetail';
import { NewTenderScreen, TendersScreen } from './screens/Tenders';
import { WinLossScreen } from './screens/TenderInsights';
import { Spinner } from '@aerolith/ui';

/** Pages opened from email links: usable in any browser, with or without an activated licence or session. */
const PUBLIC_PATHS = ['/account/set-password', '/account/reset-password'];
const SIGNED_OUT_PATHS = ['/sign-in', '/forgot'];

/** Decides what the user may see from the session state; routes below only render their screen. */
function Root() {
  const session = useSession();
  const path = useRouterState({ select: (s) => s.location.pathname });

  if (PUBLIC_PATHS.includes(path)) return <Outlet />;
  if (session.status === 'loading') return <Spinner label="Starting" />;
  if (session.status === 'needs_activation') return <ActivateScreen />;
  if (session.status === 'signed_out') {
    return SIGNED_OUT_PATHS.includes(path) ? <Outlet /> : <Navigate to="/sign-in" replace />;
  }
  if (session.mustChangePassword) return <ChangePasswordScreen forced />;
  if (SIGNED_OUT_PATHS.includes(path)) return <Navigate to="/" replace />;
  return <Outlet />;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  return user?.role === 'admin' ? <>{children}</> : <Navigate to="/" replace />;
}

const rootRoute = createRootRoute({ component: Root });
const appLayout = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppShell });

const tenderRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/tenders/$tenderId',
  component: function TenderPage() {
    const { tenderId } = tenderRoute.useParams();
    return <TenderDetailScreen key={tenderId} tenderId={tenderId} />;
  },
});

const boqRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/boqs/$boqId',
  component: function BoqPage() {
    const { boqId } = boqRoute.useParams();
    return <BoqScreen key={boqId} boqId={boqId} />;
  },
});

const pricingRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/boqs/$boqId/pricing',
  component: function PricingPage() {
    const { boqId } = pricingRoute.useParams();
    return <BoqPricingScreen key={boqId} boqId={boqId} />;
  },
});

const versionsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/boqs/$boqId/versions',
  component: function VersionsPage() {
    const { boqId } = versionsRoute.useParams();
    return <BoqVersionsScreen key={boqId} boqId={boqId} />;
  },
});

const analysisRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/rate-analyses/$analysisId',
  component: function AnalysisPage() {
    const { analysisId } = analysisRoute.useParams();
    return <AnalysisEditor key={analysisId} analysisId={analysisId} />;
  },
});

const rfqRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/rfqs/$rfqId',
  component: function RfqPage() {
    const { rfqId } = rfqRoute.useParams();
    return <RfqScreen key={rfqId} rfqId={rfqId} />;
  },
});

const routeTree = rootRoute.addChildren([
  appLayout.addChildren([
    createRoute({ getParentRoute: () => appLayout, path: '/', component: HomeScreen }),
    createRoute({ getParentRoute: () => appLayout, path: '/tenders', component: TendersScreen }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/tenders/new',
      component: NewTenderScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/tenders/win-loss',
      component: WinLossScreen,
    }),
    tenderRoute,
    boqRoute,
    createRoute({ getParentRoute: () => appLayout, path: '/clients', component: ClientsScreen }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/resources',
      component: ResourcesScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/rate-analyses',
      component: RateAnalysesScreen,
    }),
    analysisRoute,
    pricingRoute,
    versionsRoute,
    rfqRoute,
    createRoute({
      getParentRoute: () => appLayout,
      path: '/documents',
      component: DocumentsScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/users',
      component: () => (
        <AdminOnly>
          <UsersScreen />
        </AdminOnly>
      ),
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/password-resets',
      component: () => (
        <AdminOnly>
          <ResetRequestsScreen />
        </AdminOnly>
      ),
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/account/password',
      component: () => <ChangePasswordScreen forced={false} />,
    }),
  ]),
  createRoute({ getParentRoute: () => rootRoute, path: '/sign-in', component: SignInScreen }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/forgot',
    validateSearch: (s: Record<string, unknown>): { admin: boolean } => ({
      admin: s.admin === true || s.admin === 'true',
    }),
    component: function Forgot() {
      const admin = useRouterState({
        select: (s) => (s.location.search as { admin?: boolean }).admin === true,
      });
      return <ForgotScreen admin={admin} />;
    },
  }),
  ...(['setup', 'reset'] as const).map((purpose) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: purpose === 'setup' ? '/account/set-password' : '/account/reset-password',
      validateSearch: (s: Record<string, unknown>): { token: string } => ({
        token: typeof s.token === 'string' ? s.token : '',
      }),
      component: function SetPassword() {
        const token = useRouterState({
          select: (s) => (s.location.search as { token?: string }).token ?? '',
        });
        return <SetPasswordScreen token={token} purpose={purpose} />;
      },
    }),
  ),
]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
