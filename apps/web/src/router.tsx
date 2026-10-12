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
import { LicencesScreen } from './screens/Licences';
import {
  ChangePasswordScreen,
  ForgotScreen,
  SetPasswordScreen,
  YourNameCard,
} from './screens/Passwords';
import { SignInScreen } from './screens/SignIn';
import { BoqScreen } from './screens/Boq';
import { ClientsScreen } from './screens/Clients';
import { DocumentsScreen } from './screens/Documents';
import { BoqPricingScreen } from './screens/Pricing';
import { BoqVersionsScreen } from './screens/Versions';
import { AnalysisEditor, RateAnalysesScreen } from './screens/RateAnalyses';
import { ResourcesScreen } from './screens/Resources';
import { LookaheadPrint, ProgrammePrint, ProgrammeScreen } from './screens/Programme';
import {
  AnalysisReportPrint,
  CostSummaryReport,
  PipelineReport,
  ReportsScreen,
} from './screens/Reports';
import { ProjectScreen, ProjectsScreen } from './screens/Projects';
import { CostCodesScreen } from './screens/CostCodes';
import { WbsScreen } from './screens/Wbs';
import { MacroScreen } from './screens/Macro';
import { ApprovalDetailScreen } from './screens/ApprovalDetail';
import { ApprovalRulesScreen } from './screens/ApprovalRules';
import { ApprovalsScreen } from './screens/Approvals';
import { MaterialBudgetScreen } from './screens/MaterialBudget';
import { ProgressScreen } from './screens/Progress';
import { GoodsReceiptScreen } from './screens/GoodsReceipt';
import { DailyReportScreen } from './screens/DailyReport';
import { DailyReportsScreen } from './screens/DailyReports';
import { ConsumptionScreen } from './project/ProjectStores';
import { IssueScreen, StockCountScreen, TransferScreen } from './screens/StockDocs';
import { StoreScreen } from './screens/Store';
import { StoresScreen } from './screens/Stores';
import { OrdersScreen } from './screens/Orders';
import { ReceiptsScreen } from './screens/Receipts';
import { OrderOfRevisionScreen, PurchaseOrderScreen } from './screens/PurchaseOrder';
import { RequisitionScreen } from './screens/Requisition';
import {
  ProcurementReportsScreen,
  ProjectProcurementReportsScreen,
} from './screens/ProcurementReports';
import { ProjectDocumentsScreen } from './screens/ProjectDocuments';
import { ChartScreen } from './screens/accounts/Chart';
import { ClientBillScreen } from './screens/accounts/ClientBill';
import { SubcontractBillScreen } from './screens/accounts/Subcontract';
import { GstScreen } from './screens/accounts/Gst';
import { TdsScreen } from './screens/accounts/Tds';
import { BankScreen } from './screens/accounts/Bank';
import { StatementsScreen } from './screens/accounts/Statements';
import { AssetsScreen } from './screens/accounts/Assets';
import { EquipmentScreen } from './screens/accounts/Equipment';
import { EmployeeScreen, SiteRegisterScreen } from './screens/hr/Employee';
import { LeaveScreen, MyAttendanceScreen } from './screens/hr/MyAttendance';
import { PeopleScreen } from './screens/hr/People';
import { PayrollRunScreen, PayrollScreen, PayslipScreen } from './screens/payroll/Payroll';
import { LabourScreen, MusterScreen, WageSheetScreen } from './screens/labour/Labour';
import { QualityScreen } from './screens/quality/Quality';
import { SafetyScreen } from './screens/safety/Safety';
import { CashFlowScreen } from './screens/control/CashFlow';
import { CostControlScreen } from './screens/control/CostControl';
import { EarnedValueScreen } from './screens/control/EarnedValue';
import {
  ClientReceiptScreen,
  NewClientReceiptScreen,
  ReceivablesScreen,
} from './screens/accounts/Receivables';
import {
  NewPaymentRunScreen,
  NewVendorBillScreen,
  PayablesScreen,
  PaymentRunScreen,
  VendorBillScreen,
} from './screens/accounts/Payables';
import { CompaniesScreen } from './screens/accounts/Companies';
import { DayBookScreen, LedgerScreen, TrialBalanceScreen } from './screens/accounts/Reports';
import { BooksSetupScreen } from './screens/accounts/Setup';
import { NewVoucherScreen, VoucherScreen, VouchersScreen } from './screens/accounts/Vouchers';
import { RequisitionsScreen } from './screens/Requisitions';
import { ProjectDashboardScreen } from './screens/ProjectDashboard';
import { RfqScreen } from './screens/Rfq';
import { TemplatesScreen } from './screens/Templates';
import { TenderSettingsScreen } from './screens/TenderSettings';
import { TenderDetailScreen } from './screens/TenderDetail';
import { NewTenderScreen, TendersScreen } from './screens/Tenders';
import { WinLossScreen } from './screens/TenderInsights';
import { Spinner } from '@aerolith/ui';
import { lazy, Suspense } from 'react';

// Charts (ECharts) load only when a dashboard is opened, not with the app.
const DashboardScreen = lazy(() =>
  import('./screens/Dashboards').then((m) => ({ default: m.DashboardScreen })),
);

/** Pages opened from email links: usable in any browser, with or without an activated licence or session. */
const PUBLIC_PATHS = ['/account/set-password', '/account/reset-password', '/licences'];
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

const projectRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects/$projectId',
  component: function ProjectPage() {
    const { projectId } = projectRoute.useParams();
    return <ProjectScreen key={projectId} projectId={projectId} />;
  },
});
const progressRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects/$projectId/progress',
  component: function ProgressPage() {
    const { projectId } = progressRoute.useParams();
    return <ProgressScreen key={projectId} projectId={projectId} />;
  },
});
const projectDashboardRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects/$projectId/dashboard',
  component: function ProjectDashboardPage() {
    const { projectId } = projectDashboardRoute.useParams();
    return <ProjectDashboardScreen key={projectId} projectId={projectId} />;
  },
});
const approvalRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/approvals/$approvalId',
  component: function ApprovalPage() {
    const { approvalId } = approvalRoute.useParams();
    return <ApprovalDetailScreen key={approvalId} approvalId={approvalId} />;
  },
});
const materialBudgetRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/material-budgets/$budgetId',
  component: function MaterialBudgetPage() {
    const { budgetId } = materialBudgetRoute.useParams();
    return <MaterialBudgetScreen key={budgetId} budgetId={budgetId} />;
  },
});
const requisitionRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/requisitions/$requisitionId',
  component: function RequisitionPage() {
    const { requisitionId } = requisitionRoute.useParams();
    return <RequisitionScreen key={requisitionId} requisitionId={requisitionId} />;
  },
});
const orderRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/orders/$orderId',
  component: function OrderPage() {
    const { orderId } = orderRoute.useParams();
    return <PurchaseOrderScreen key={orderId} orderId={orderId} />;
  },
});
const orderRevisionRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/orders/revision/$revisionId',
  component: function OrderRevisionPage() {
    const { revisionId } = orderRevisionRoute.useParams();
    return <OrderOfRevisionScreen key={revisionId} revisionId={revisionId} />;
  },
});
const receiptRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/receipts/$receiptId',
  component: function ReceiptPage() {
    const { receiptId } = receiptRoute.useParams();
    return <GoodsReceiptScreen key={receiptId} receiptId={receiptId} />;
  },
});
const storeRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/stores/$storeId',
  component: function StorePage() {
    const { storeId } = storeRoute.useParams();
    return <StoreScreen key={storeId} storeId={storeId} />;
  },
});
const issueRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/issues/$issueId',
  component: function IssuePage() {
    const { issueId } = issueRoute.useParams();
    return <IssueScreen key={issueId} issueId={issueId} />;
  },
});
const transferRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/transfers/$transferId',
  component: function TransferPage() {
    const { transferId } = transferRoute.useParams();
    return <TransferScreen key={transferId} transferId={transferId} />;
  },
});
const stockCountRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/stock-counts/$countId',
  component: function StockCountPage() {
    const { countId } = stockCountRoute.useParams();
    return <StockCountScreen key={countId} countId={countId} />;
  },
});
const consumptionRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects/$projectId/consumption',
  component: function ConsumptionPage() {
    const { projectId } = consumptionRoute.useParams();
    return <ConsumptionScreen key={projectId} projectId={projectId} />;
  },
});
const dailyReportRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/daily-reports/$reportId',
  component: function DailyReportPage() {
    const { reportId } = dailyReportRoute.useParams();
    return <DailyReportScreen key={reportId} reportId={reportId} />;
  },
});
const dailyReportsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects/$projectId/daily-reports',
  validateSearch: (s: Record<string, unknown>): { site?: string | undefined } => ({
    site: typeof s.site === 'string' ? s.site : undefined,
  }),
  component: function DailyReportsPage() {
    const { projectId } = dailyReportsRoute.useParams();
    const { site } = dailyReportsRoute.useSearch();
    return <DailyReportsScreen key={projectId} projectId={projectId} siteId={site} />;
  },
});
const projectDocumentsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects/$projectId/documents',
  component: function ProjectDocumentsPage() {
    const { projectId } = projectDocumentsRoute.useParams();
    return <ProjectDocumentsScreen key={projectId} projectId={projectId} />;
  },
});
const projectProcurementRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects/$projectId/procurement-reports',
  component: function ProjectProcurementPage() {
    const { projectId } = projectProcurementRoute.useParams();
    return <ProjectProcurementReportsScreen key={projectId} projectId={projectId} />;
  },
});
const clientBillRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/client-bills/$billId',
  component: function ClientBillPage() {
    const { billId } = clientBillRoute.useParams();
    return <ClientBillScreen key={billId} billId={billId} />;
  },
});
const subcontractBillRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/subcontract-bills/$billId',
  component: function SubcontractBillPage() {
    const { billId } = subcontractBillRoute.useParams();
    return <SubcontractBillScreen key={billId} billId={billId} />;
  },
});
const employeeRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/hr/employees/$employeeId',
  component: function EmployeePage() {
    const { employeeId } = employeeRoute.useParams();
    return <EmployeeScreen key={employeeId} employeeId={employeeId} />;
  },
});
const leaveRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/hr/leave/$leaveId',
  component: function LeavePage() {
    const { leaveId } = leaveRoute.useParams();
    return <LeaveScreen key={leaveId} leaveId={leaveId} />;
  },
});
const payrollRunRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/payroll/runs/$runId',
  component: function PayrollRunPage() {
    const { runId } = payrollRunRoute.useParams();
    return <PayrollRunScreen key={runId} runId={runId} />;
  },
});
const payslipRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/payroll/runs/$runId/payslips/$employeeId',
  component: function PayslipPage() {
    const { runId, employeeId } = payslipRoute.useParams();
    return <PayslipScreen key={`${runId}-${employeeId}`} runId={runId} employeeId={employeeId} />;
  },
});
const wageSheetRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/labour/wage-sheets/$sheetId',
  component: function WageSheetPage() {
    const { sheetId } = wageSheetRoute.useParams();
    return <WageSheetScreen key={sheetId} sheetId={sheetId} />;
  },
});
const clientReceiptRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/accounts/client-receipts/$receiptId',
  component: function ClientReceiptPage() {
    const { receiptId } = clientReceiptRoute.useParams();
    return <ClientReceiptScreen key={receiptId} receiptId={receiptId} />;
  },
});
const vendorBillRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/accounts/vendor-bills/$billId',
  component: function VendorBillPage() {
    const { billId } = vendorBillRoute.useParams();
    return <VendorBillScreen key={billId} billId={billId} />;
  },
});
const paymentRunRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/accounts/payment-runs/$runId',
  component: function PaymentRunPage() {
    const { runId } = paymentRunRoute.useParams();
    return <PaymentRunScreen key={runId} runId={runId} />;
  },
});
const voucherRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/accounts/vouchers/$voucherId',
  component: function VoucherPage() {
    const { voucherId } = voucherRoute.useParams();
    return <VoucherScreen key={voucherId} voucherId={voucherId} />;
  },
});
const ledgerRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/accounts/ledgers/$accountId',
  validateSearch: (
    s: Record<string, unknown>,
  ): { entityId?: string | undefined; from?: string | undefined; to?: string | undefined } => ({
    entityId: typeof s.entityId === 'string' ? s.entityId : undefined,
    from: typeof s.from === 'string' ? s.from : undefined,
    to: typeof s.to === 'string' ? s.to : undefined,
  }),
  component: function LedgerPage() {
    const { accountId } = ledgerRoute.useParams();
    return <LedgerScreen key={accountId} accountId={accountId} search={ledgerRoute.useSearch()} />;
  },
});
const macroRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects/$projectId/macro',
  component: function MacroPage() {
    const { projectId } = macroRoute.useParams();
    return <MacroScreen key={projectId} projectId={projectId} />;
  },
});
const wbsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects/$projectId/wbs',
  component: function WbsPage() {
    const { projectId } = wbsRoute.useParams();
    return <WbsScreen key={projectId} projectId={projectId} />;
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

const programmeRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/programmes/$planId',
  component: function ProgrammePage() {
    const { planId } = programmeRoute.useParams();
    return <ProgrammeScreen key={planId} planId={planId} />;
  },
});

/** The print view has no menus around it: it is the paper. */
const programmePrintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/programmes/$planId/print',
  component: function ProgrammePrintPage() {
    const { planId } = programmePrintRoute.useParams();
    return <ProgrammePrint planId={planId} />;
  },
});

/** The look-ahead, like the print view, is the paper: what is on and coming in the next weeks. */
const lookaheadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/programmes/$planId/lookahead',
  component: function LookaheadPage() {
    const { planId } = lookaheadRoute.useParams();
    return <LookaheadPrint planId={planId} />;
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/dashboards/$name',
  component: function DashboardPage() {
    const { name } = dashboardRoute.useParams();
    return name === 'tender' || name === 'estimation' ? (
      <Suspense fallback={<Spinner />}>
        <DashboardScreen key={name} name={name} />
      </Suspense>
    ) : (
      <Navigate to="/dashboards/$name" params={{ name: 'tender' }} replace />
    );
  },
});

/** Reports are paper too: a toolbar that does not print, and the page. */
const costSummaryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/boqs/$boqId/cost-summary',
  component: function CostSummaryPage() {
    const { boqId } = costSummaryRoute.useParams();
    return <CostSummaryReport key={boqId} boqId={boqId} />;
  },
});

const analysisReportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/boqs/$boqId/analysis-report',
  component: function AnalysisReportPage() {
    const { boqId } = analysisReportRoute.useParams();
    return <AnalysisReportPrint key={boqId} boqId={boqId} />;
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
    createRoute({ getParentRoute: () => appLayout, path: '/projects', component: ProjectsScreen }),
    projectRoute,
    wbsRoute,
    macroRoute,
    progressRoute,
    projectDashboardRoute,
    approvalRoute,
    requisitionRoute,
    materialBudgetRoute,
    orderRoute,
    orderRevisionRoute,
    receiptRoute,
    dailyReportRoute,
    dailyReportsRoute,
    projectDocumentsRoute,
    projectProcurementRoute,
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/vouchers',
      component: VouchersScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/vouchers/new',
      component: NewVoucherScreen,
    }),
    voucherRoute,
    ledgerRoute,
    clientBillRoute,
    subcontractBillRoute,
    employeeRoute,
    leaveRoute,
    payrollRunRoute,
    payslipRoute,
    wageSheetRoute,
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/receivables',
      component: ReceivablesScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/client-receipts/new',
      component: NewClientReceiptScreen,
    }),
    clientReceiptRoute,
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/payables',
      component: PayablesScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/vendor-bills/new',
      component: NewVendorBillScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/payment-runs/new',
      component: NewPaymentRunScreen,
    }),
    vendorBillRoute,
    paymentRunRoute,
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/gst',
      component: GstScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/tds',
      component: TdsScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/bank',
      component: BankScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/statements',
      component: StatementsScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/assets',
      component: AssetsScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/equipment',
      component: EquipmentScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/hr',
      component: PeopleScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/hr/me',
      component: MyAttendanceScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/hr/register',
      component: SiteRegisterScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/payroll',
      component: PayrollScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/labour',
      component: LabourScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/labour/muster',
      component: MusterScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/quality',
      component: QualityScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/safety',
      component: SafetyScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/cost-control',
      component: CostControlScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/cash-flow',
      component: CashFlowScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/earned-value',
      component: EarnedValueScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/trial-balance',
      component: TrialBalanceScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/day-book',
      component: DayBookScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/chart',
      component: ChartScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/accounts/setup',
      component: BooksSetupScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/settings/companies',
      component: CompaniesScreen,
    }),
    storeRoute,
    issueRoute,
    transferRoute,
    stockCountRoute,
    consumptionRoute,
    createRoute({
      getParentRoute: () => appLayout,
      path: '/stores',
      component: StoresScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/receipts',
      component: ReceiptsScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/procurement-reports',
      component: ProcurementReportsScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/orders',
      component: OrdersScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/approvals',
      component: ApprovalsScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/requisitions',
      component: RequisitionsScreen,
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/settings/approvals',
      component: () => (
        <AdminOnly>
          <ApprovalRulesScreen />
        </AdminOnly>
      ),
    }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/cost-codes',
      component: CostCodesScreen,
    }),
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
    programmeRoute,
    createRoute({ getParentRoute: () => appLayout, path: '/reports', component: ReportsScreen }),
    createRoute({
      getParentRoute: () => appLayout,
      path: '/boq-templates',
      component: TemplatesScreen,
    }),
    dashboardRoute,
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
      path: '/settings/tenders',
      component: () => (
        <AdminOnly>
          <TenderSettingsScreen />
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
      component: () => (
        <>
          <YourNameCard />
          <ChangePasswordScreen forced={false} />
        </>
      ),
    }),
  ]),
  programmePrintRoute,
  lookaheadRoute,
  costSummaryRoute,
  analysisReportRoute,
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/reports/pipeline',
    component: PipelineReport,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/sign-in', component: SignInScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/licences', component: LicencesScreen }),
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
