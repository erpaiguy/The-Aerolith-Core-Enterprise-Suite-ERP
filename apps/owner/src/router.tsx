import { Spinner } from '@aerolith/ui';
import {
  Navigate,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { AccountScreen, ForcedPasswordScreen } from './screens/Account';
import { AuditScreen } from './screens/Audit';
import { EmailScreen } from './screens/Email';
import { MigrationsScreen } from './screens/Migrations';
import { OverviewScreen } from './screens/Overview';
import { Shell } from './screens/Shell';
import { SignInScreen } from './screens/SignIn';
import { TenantDetailScreen } from './screens/TenantDetail';
import { TenantsScreen } from './screens/Tenants';
import { useSession } from './session';

/** Every page needs a signed-in operator who has replaced the one-time password. */
function Root() {
  const session = useSession();
  if (session.status === 'loading') return <Spinner label="Starting" />;
  if (session.status === 'signed_out') return <SignInScreen />;
  if (session.mustChangePassword) return <ForcedPasswordScreen />;
  return <Outlet />;
}

const rootRoute = createRootRoute({ component: Root });
const shell = createRoute({ getParentRoute: () => rootRoute, id: 'shell', component: Shell });
const page = (path: string, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => shell, path, component });

const tenantRoute = createRoute({
  getParentRoute: () => shell,
  path: '/tenants/$tenantId',
  component: function TenantPage() {
    const { tenantId } = tenantRoute.useParams();
    return <TenantDetailScreen key={tenantId} tenantId={tenantId} />;
  },
});

const routeTree = rootRoute.addChildren([
  shell.addChildren([
    page('/', OverviewScreen),
    page('/tenants', TenantsScreen),
    tenantRoute,
    page('/email', EmailScreen),
    page('/migrations', MigrationsScreen),
    page('/audit', AuditScreen),
    page('/account', AccountScreen),
  ]),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '*',
    component: () => <Navigate to="/" replace />,
  }),
]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
