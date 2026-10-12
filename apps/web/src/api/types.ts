export type Role = 'admin' | 'manager' | 'worker';
export type LicenceState = 'active' | 'grace' | 'read_only' | 'suspended' | 'revoked';

export interface Entitlement {
  lic: string;
  ten: string;
  tier: string;
  seats: number;
  state: LicenceState;
  ends: string;
  exp: number;
}

export interface ActivationResult {
  token: string;
  entitlement: Entitlement;
  featuresUnlocked: boolean;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export type LoginResult =
  | {
      status: 'ok';
      accessToken: string;
      refreshToken?: string;
      user: SessionUser;
      mustChangePassword: boolean;
      licence: { state: LicenceState; featuresUnlocked: boolean };
    }
  | { status: 'mfa_required' }
  | { status: 'mfa_enrollment_required'; enrollmentToken: string };

export interface Me extends SessionUser {
  mustChangePassword: boolean;
  licence: { state: LicenceState; featuresUnlocked: boolean };
}

export interface InboxItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  dueAt: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface Inbox {
  items: InboxItem[];
  upcoming: InboxItem[];
  unread: number;
  pending: {
    passwordResets: number;
    approvals: number;
    reviews: number;
    signoffs: number;
    receipts: number;
  };
}

export interface OwnerNotice {
  id: string;
  kind: string;
  title: string;
  body: string;
  created_at: string;
}

export interface TenantUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'deactivated';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface ResetRequest {
  id: string;
  requestedAt: string;
  deviceLabel: string | null;
  userId: string;
  username: string;
  displayName: string;
}

// --- Tenders (docs/wave1-plan.md step 1) ---

export const TENDER_STATUSES = [
  'lead',
  'evaluating',
  'bidding',
  'submitted',
  'won',
  'lost',
  'no_bid',
  'withdrawn',
  'cancelled',
] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

export interface Party {
  id: string;
  name: string;
  isClient: boolean;
  isVendor: boolean;
  isSubcontractor: boolean;
  isCompetitor: boolean;
  gstin: string | null;
  pan: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string;
  /** A supplier's default TDS section and bank account (docs/wave3-plan.md step 4). */
  tdsSection?: string | null;
  bankAccountName?: string | null;
  bankAccountNo?: string | null;
  bankIfsc?: string | null;
  /** What e-invoices and TDS returns need of a client (docs/wave3-plan.md step 6). */
  legalName?: string | null;
  city?: string;
  pincode?: string | null;
  stateCode?: string | null;
  tan?: string | null;
  rowVersion: number;
}

export interface Person {
  id: string;
  displayName: string;
  role: Role;
}

export interface TenderSummary {
  id: string;
  number: string;
  title: string;
  status: TenderStatus;
  clientRef: string | null;
  vertical: string;
  location: string | null;
  estimatedValue: string | null;
  submissionDueAt: string | null;
  updatedAt: string;
  client: { id: string; name: string } | null;
  owner: { id: string; displayName: string } | null;
  latestScore: string | null;
}

export interface Criterion {
  key: string;
  label: string;
  weight: number;
  score: number;
}

export interface TenderDetail extends TenderSummary {
  source: string;
  portalUrl: string | null;
  emdAmount: string | null;
  tenderFee: string | null;
  publishedOn: string | null;
  prebidAt: string | null;
  openingAt: string | null;
  queriesDueAt: string | null;
  bidValidityDays: number | null;
  statusReason: string | null;
  description: string;
  createdAt: string;
  rowVersion: number;
  resultOn: string | null;
  resultCategory: ResultCategory | null;
  awardedValue: string | null;
  awardedTo: { id: string; name: string } | null;
  allowedMoves: TenderStatus[];
  canDecide: boolean;
  defaultCriteria: Omit<Criterion, 'score'>[];
  decisions: {
    id: string;
    criteria: Criterion[];
    score: string;
    decision: 'bid' | 'no_bid';
    reason: string;
    decidedAt: string;
    decidedBy: string;
  }[];
  events: {
    id: string;
    kind: string;
    data: Record<string, unknown>;
    createdAt: string;
    actor: string | null;
  }[];
}

// --- Tender management detail (apps/api/src/tender/tender-work.service.ts, step 8) ---

export type ResultCategory =
  'price' | 'technical' | 'qualification' | 'documents' | 'scope' | 'client' | 'other';
export type QueryStatus = 'draft' | 'sent' | 'answered' | 'withdrawn';
export type SecurityStatus =
  'planned' | 'issued' | 'submitted' | 'returned' | 'adjusted' | 'forfeited' | 'cancelled';
export type SecurityForm =
  'bank_guarantee' | 'demand_draft' | 'fdr' | 'online' | 'insurance_bond' | 'exempt';

export interface TenderQuery {
  id: string;
  seq: number;
  reference: string;
  question: string;
  status: QueryStatus;
  sentOn: string | null;
  answer: string;
  answeredOn: string | null;
  addendumId: string | null;
  rowVersion: number;
}

export interface Addendum {
  id: string;
  ref: string;
  issuedOn: string;
  summary: string;
  dueBefore: string | null;
  dueAfter: string | null;
  affectsBoq: boolean;
  acknowledged: boolean;
  rowVersion: number;
  /** Tender documents linked to it (the corrigendum itself). */
  documents: { id: string; name: string }[];
}

export interface SecurityInstrument {
  id: string;
  purpose: 'emd' | 'performance' | 'other';
  form: SecurityForm;
  amount: string;
  bank: string | null;
  instrumentNo: string | null;
  issuedOn: string | null;
  validUntil: string | null;
  claimUntil: string | null;
  status: SecurityStatus;
  returnedOn: string | null;
  notes: string;
  shortOfValidity: boolean;
  rowVersion: number;
}

export interface ChecklistItem {
  id: string;
  seq: number;
  envelope: 'technical' | 'financial' | 'other';
  title: string;
  required: boolean;
  status: 'pending' | 'ready' | 'not_applicable';
  assigneeId: string | null;
  assignee: string | null;
  dueOn: string | null;
  notes: string;
  doneAt: string | null;
  rowVersion: number;
  /** Tender documents linked to it (the certificate it asks for). */
  documents: { id: string; name: string }[];
}

export interface Submission {
  id: string;
  kind: 'original' | 'revised';
  submittedAt: string;
  mode: 'portal' | 'physical' | 'email' | 'other';
  reference: string | null;
  /** Hidden (null) from roles without the pricing permission. */
  bidValue: string | null;
  notes: string;
  by: string | null;
}

export interface OpenedBid {
  id: string;
  partyId: string | null;
  name: string | null;
  us: boolean;
  quotedValue: string | null;
  qualified: boolean;
  notes: string;
  rank: number | null;
}

export interface TenderWork {
  queries: TenderQuery[];
  addenda: Addendum[];
  securities: SecurityInstrument[];
  checklist: ChecklistItem[];
  submissions: Submission[];
  bids: OpenedBid[];
  opening: {
    bidders: number;
    ourRank: number | null;
    l1: { name: string | null; value: string | null; us: boolean } | null;
    aboveL1Pct: number | null;
  } | null;
  bidValidityEnd: string | null;
  readiness: {
    checklistRequired: number;
    checklistPending: string[];
    addendaUnacknowledged: number;
    emdRequired: boolean;
    emdCovered: boolean;
    queriesUnanswered: number;
  };
}

export interface AgendaItem {
  at: string;
  allDay: boolean;
  kind: 'submission' | 'prebid' | 'queries' | 'opening' | 'security_expiry' | 'checklist';
  label: string;
  tender: { id: string; number: string; title: string };
}

export interface WinLossTally {
  submitted: number;
  won: number;
  lost: number;
  pending: number;
  winRatePct: number | null;
  bidValue: string;
  wonValue: string;
  winRateByValuePct: number | null;
}

export interface WinLoss {
  years: string[];
  fy: string | null;
  totals: WinLossTally;
  byClient: (WinLossTally & { name: string })[];
  byVertical: (WinLossTally & { name: string })[];
  lossReasons: { category: ResultCategory | 'not_recorded'; count: number }[];
  position: { opened: number; l1: number; avgAboveL1Pct: number | null };
  competitors: {
    id: string;
    name: string;
    met: number;
    beatUs: number;
    weBeat: number;
    won: number;
    avgGapPct: number | null;
  }[];
}

// --- BOQ import (apps/api/src/boq/import) ---

export type ImportField =
  'code' | 'description' | 'unit' | 'qty' | 'rate' | 'amount' | 'level' | 'type' | 'notes';
export type ImportStructure = 'headings' | 'numbering' | 'level' | 'flat';

export interface ImportSettings {
  sheet: number;
  headerRow: number | null;
  mapping: Partial<Record<ImportField, number>>;
  structure: ImportStructure;
  normaliseUnits: boolean;
}

export interface ImportIssue {
  rowNo: number;
  field?: ImportField;
  severity: 'error' | 'warning';
  message: string;
}

export interface ImportRevision {
  before: number;
  matchedByCode: number;
  matchedByDescription: number;
  unchanged: number;
  changed: number;
  moved: number;
  added: number;
  removed: number;
  measuredOverridden: number;
  ratesKept: number;
  ratesFromFile: number;
  total: string;
  samples: {
    change: 'added' | 'removed' | 'changed' | 'moved';
    code: string | null;
    description: string;
    detail: string;
  }[];
}

export interface ImportJob {
  id: string;
  boqId: string;
  fileName: string;
  fileType: 'xlsx' | 'csv';
  fileSize: number;
  status:
    | 'scanning'
    | 'uploaded'
    | 'validating'
    | 'validated'
    | 'importing'
    | 'imported'
    | 'failed'
    | 'cancelled';
  sheets: {
    name: string;
    rows: number;
    columns: number;
    preview: { rowNo: number; cells: string[] }[];
    detected: Pick<ImportSettings, 'headerRow' | 'mapping' | 'structure'>;
  }[];
  settings: ImportSettings | null;
  summary: {
    counts: {
      rows: number;
      sections: number;
      items: number;
      notes: number;
      skipped: number;
      errors: number;
      warnings: number;
      unitsNormalised: number;
    };
    lines: number;
    total: string;
    issues: ImportIssue[];
    moreIssues: number;
    unknownUnits: { unit: string; rows: number }[];
    /** Into a BOQ that has lines: what the revised file changes. */
    revision?: ImportRevision;
    result?: { nodeCount: number; itemCount: number; total: string; seconds: number };
  } | null;
  progress: number;
  error: string | null;
}

// --- Rate library and rate analysis (apps/api/src/rates) ---

export type ResourceKind = 'material' | 'labour' | 'equipment' | 'subcontract' | 'other';
export const RESOURCE_KINDS: { value: ResourceKind; label: string }[] = [
  { value: 'material', label: 'Material' },
  { value: 'labour', label: 'Labour' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'subcontract', label: 'Subcontract' },
  { value: 'other', label: 'Other' },
];

export interface Resource {
  id: string;
  code: string;
  name: string;
  kind: ResourceKind;
  unit: string;
  notes: string;
  active: boolean;
  rowVersion: number;
  /** In force on the date asked for (list) or today (detail); null when there is none yet. */
  rate: string | null;
  rateFrom: string | null;
}

export interface ResourceDetail extends Resource {
  rates: { effectiveFrom: string; rate: string; source: string; createdAt: string }[];
  usedIn: { id: string; code: string; description: string }[];
}

export interface PriceBookResult {
  dryRun: boolean;
  headerRow: number;
  rows: number;
  created: number;
  updated: number;
  rates: number;
  unchanged: number;
  errors: number;
  issues: { rowNo: number; message: string }[];
  unitChanged: { code: string; from: string; to: string }[];
}

export interface Costing {
  unitRate: string;
  boqRate: string;
  subtotal: string;
  total: string;
  lines: { lineNo: number; unitCost: string | null; cost: string }[];
  additions: { label: string; pct: string; amount: string }[];
  byKind: Record<ResourceKind, string>;
  additionsPerUnit: string;
  missing: { id: string; code: string; name: string }[];
}

export interface AnalysisSummary {
  id: string;
  code: string;
  description: string;
  unit: string;
  outputQty: string;
  active: boolean;
  boqRate: string;
  unitRate: string;
  missing: number;
}

export interface AnalysisLine {
  kind: 'resource' | 'analysis' | 'lump_sum';
  resourceId: string | null;
  subAnalysisId: string | null;
  description: string;
  qty: string;
  wastagePct: string;
  amount: string | null;
  resource?: {
    code: string;
    name: string;
    kind: ResourceKind;
    unit: string;
    active: boolean;
  } | null;
  subAnalysis?: { code: string; description: string; unit: string; active: boolean } | null;
}

export interface AnalysisDetail {
  id: string;
  code: string;
  description: string;
  unit: string;
  outputQty: string;
  additions: { label: string; pct: string }[];
  notes: string;
  active: boolean;
  rowVersion: number;
  asOf: string;
  lines: AnalysisLine[];
  costing: Costing;
  usedBy: { id: string; code: string; description: string }[];
  boqs: { id: string; name: string; tenderNumber: string; items: number }[];
}

// --- Bid pricing (apps/api/src/pricing) ---

export type MarkupKind =
  'overhead' | 'profit' | 'contingency' | 'escalation' | 'discount' | 'other';
export type GstMode = 'add' | 'included' | 'exempt';

export interface Markup {
  kind: MarkupKind;
  label: string;
  basis: 'base' | 'running';
  pct: string | null;
  amount: string | null;
}

export interface Priced {
  base: string;
  /** Provisional sums inside the base: no markups on them. */
  provisional?: string;
  markups: { kind: MarkupKind; label: string; basis: string; pct: string | null; amount: string }[];
  markupTotal: string;
  beforeGst: string;
  gst: string;
  gstIncluded: string | null;
  bid: string;
  factor: string;
  vsEstimatePct: string | null;
}

export interface Scenario {
  id: string;
  boqId: string;
  name: string;
  notes: string;
  markups: Markup[];
  gstPct: string;
  gstMode: GstMode;
  selected: boolean;
  rowVersion: number;
  result: Priced;
}

export interface PricingSummary {
  boq: { id: string; name: string; status: string; base: string; provisional?: string };
  tender: { id: string; number: string; title: string; estimatedValue: string | null };
  counts: { items: number; unpriced: number; noQty: number; measured: number };
  sections: { id: string; code: string | null; description: string; subtotal: string }[];
  unsectioned: { amount: string; items: number };
  scenarios: Scenario[];
  quoted: { factor: string; total: string; difference: string } | null;
}

export interface TenderBidSummary {
  estimatedValue: string | null;
  boqs: {
    id: string;
    name: string;
    base: string;
    unpriced: number;
    scenario: { id: string; name: string } | null;
    beforeGst: string | null;
    gst: string | null;
    bid: string | null;
  }[];
  base: string;
  beforeGst: string;
  gst: string;
  bid: string;
  complete: boolean;
  vsEstimatePct: string | null;
}

// --- BOQ revisions (apps/api/src/boq/revision.service.ts) ---

export interface BoqVersion {
  versionNo: number;
  kind: 'submitted' | 'internal';
  label: string;
  note: string;
  frozenAt: string;
  frozenBy: string | null;
  total: string;
  nodeCount: number;
  itemCount: number;
  rateDate: string;
  scenario: { name: string; result: { beforeGst: string; gst: string; bid: string } } | null;
}

export interface BoqVersions {
  current: {
    versionNo: number;
    status: 'draft' | 'locked' | 'submitted';
    total: string;
    nodeCount: number;
    itemCount: number;
  };
  versions: BoqVersion[];
}

export interface VersionChange {
  lineKey: string;
  change: 'added' | 'removed' | 'changed';
  type: 'section' | 'item' | 'note';
  moved: boolean;
  codeA: string | null;
  codeB: string | null;
  unitA: string | null;
  unitB: string | null;
  qtyA: string | null;
  qtyB: string | null;
  rateA: string | null;
  rateB: string | null;
  amountA: string | null;
  amountB: string | null;
  descriptionA: string | null;
  descriptionB: string | null;
  notesA: string | null;
  notesB: string | null;
}

export interface VersionCompare {
  from: { version: number; total: string | null };
  to: { version: number; total: string | null };
  summary: { added: number; removed: number; changed: number; itemsDelta: string };
  rows: VersionChange[];
  hasMore: boolean;
}

// --- RFQs (apps/api/src/rfq) ---

export type RfqKind = 'work' | 'material';
export type RfqStatus = 'draft' | 'sent' | 'closed' | 'cancelled';
/** How a vendor's rates treat GST (not the bid's GST: see GstMode). */
export type QuoteGstMode = 'extra' | 'included' | 'exempt';
export type RfqVendorStatus = 'invited' | 'sent' | 'quoted' | 'declined';

export interface RfqSummary {
  id: string;
  number: string;
  title: string;
  kind: RfqKind;
  dueOn: string | null;
  status: RfqStatus;
  lines: number;
  vendors: number;
  quotes: number;
}

export interface RfqCell {
  /** As quoted (with GST when the quote includes it). */
  rate: string;
  /** Before GST. */
  basic: string;
  amount: string | null;
  /** 1 = lowest on the line; equal rates share a rank. */
  rank: number;
  remark: string;
}

export interface RfqLine {
  id: string;
  seq: number;
  boqId: string | null;
  boqName: string | null;
  resourceId: string | null;
  code: string | null;
  description: string;
  unit: string | null;
  qty: string | null;
  selectedPartyId: string | null;
  selectionNote: string;
  /** The estimate's current rate for the item or resource. */
  ourRate: string | null;
  ourAmount: string | null;
  /** The BOQ item was deleted since it was asked for. */
  gone: boolean;
  cells: Record<string, RfqCell>;
  /** The single lowest vendor; null when nobody quoted or two tie. */
  l1: string | null;
  lowest: string | null;
  selected: { partyId: string; basic: string; amount: string | null } | null;
  /** A project's RFQ: the approved requisitions the line asks for, and how much of each. */
  requisitions?: { requisitionId: string; number: string; qty: string }[];
}

export interface RfqQuote {
  receivedOn: string;
  validUntil: string | null;
  reference: string | null;
  gstMode: QuoteGstMode;
  gstPct: string;
  terms: string;
  source: 'typed' | 'file';
  fileName: string | null;
  /** Negotiation round: 1 for the first quote, one more for each revised quote. */
  round: number;
}

export interface RfqVendor {
  partyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: RfqVendorStatus;
  sentOn: string | null;
  notes: string;
  quote: RfqQuote | null;
  /** Tender documents linked to this vendor's quote. */
  documents: { id: string; name: string; versionNo: number }[];
}

/** One negotiation round of a vendor, every rate before GST. */
export interface RfqRound {
  partyId: string;
  round: number;
  receivedOn: string;
  gstMode: QuoteGstMode;
  /** line id -> rate before GST */
  rates: Record<string, string>;
  total: string;
}

export interface RfqVendorTotal {
  partyId: string;
  name: string;
  gstMode: QuoteGstMode;
  gstPct: string;
  linesQuoted: number;
  /** Priced every line: only complete quotes are ranked. */
  complete: boolean;
  linesL1: number;
  basicTotal: string;
  gst: string;
  total: string;
  rank: number | null;
}

export interface RfqDetail {
  id: string;
  /** A tender's RFQ (Wave 1), or a project's (Wave 2b step 3). */
  tenderId: string | null;
  projectId: string | null;
  number: string;
  title: string;
  kind: RfqKind;
  dueOn: string | null;
  status: RfqStatus;
  terms: string;
  rowVersion: number;
  tender: { id: string; number: string; title: string } | null;
  project: { id: string; number: string; name: string } | null;
  lines: RfqLine[];
  vendors: RfqVendor[];
  /** Vendors who revised their quote: every round, the current one last. */
  rounds: RfqRound[];
  cs: {
    vendors: RfqVendorTotal[];
    totals: {
      splitL1: string;
      selected: string;
      linesSelected: number;
      estimate: string;
      linesUnpriced: number;
    };
  };
}

export interface RfqApplyResult {
  boqs: {
    boqId: string;
    name: string;
    updated: number;
    unchanged: number;
    skipped: string | null;
  }[];
  resources: number;
  rfq: RfqDetail;
}

export interface RfqQuoteImport {
  rfq: RfqDetail;
  lines: number;
  skipped: number;
  issues: string[];
}

// --- Tender documents (apps/api/src/documents) ---

export interface DocFolder {
  id: string;
  parentId: string | null;
  name: string;
  /** Visible only to roles that see bid pricing. */
  restricted: boolean;
  rowVersion: number;
}

export interface DocItem {
  id: string;
  folderId: string | null;
  name: string;
  description: string;
  tags: string[];
  versionNo: number;
  rowVersion: number;
  size: number;
  mime: string;
  scanStatus: 'clean' | 'not_scanned';
  uploadedAt: string;
  uploadedBy: string | null;
  deletedAt: string | null;
  /** The latest version has a thumbnail. */
  hasThumbnail: boolean;
}

export interface DocVault {
  folders: DocFolder[];
  documents: DocItem[];
  /** A project's vault: the won tender it was made from, whose documents stay there. */
  fromTender?: { id: string; number: string; title: string } | null;
  trashCount: number;
  /** Days the trash keeps a document before it is deleted for good; null: for ever. */
  trashDays: number | null;
  canSeeRestricted: boolean;
  maxBytes: number;
}

export interface DocDetail {
  id: string;
  tenderId: string;
  tender: { number: string; title: string };
  folderId: string | null;
  name: string;
  description: string;
  tags: string[];
  versionNo: number;
  rowVersion: number;
  deletedAt: string | null;
  path: { id: string; name: string }[];
  versions: {
    versionNo: number;
    size: number;
    mime: string;
    originalName: string;
    note: string;
    scanStatus: 'clean' | 'not_scanned';
    uploadedAt: string;
    uploadedBy: string | null;
    /** PDFs: whether their text was read for search. */
    text: {
      status: 'pending' | 'working' | 'done' | 'failed' | 'skipped';
      pages: number | null;
      note: string | null;
    } | null;
  }[];
}

export interface DocUploadResult {
  outcome: 'created' | 'new_version' | 'unchanged';
  document: { id: string; name: string; folderId: string | null; versionNo: number };
}

export interface DocSearchHit extends DocItem {
  /** One of the two: a tender's document or a project's. */
  tenderId: string | null;
  tender: { number: string; title: string } | null;
  projectId: string | null;
  project: { number: string; name: string } | null;
  folder: string | null;
  /** Found by words inside the PDF: the passage, the words between \u0002 and \u0003. */
  snippet: string | null;
}

// --- reports (step 12) ---

export interface ReportBoq {
  id: string;
  name: string;
  status: string;
  versionNo: number;
  rateDate: string;
  total: string;
  archived: boolean;
  /** One of the two: a tender's estimate, or a project's contract BOQ or budget. */
  tender: {
    id: string;
    number: string;
    title: string;
    client: string | null;
    estimatedValue: string | null;
  } | null;
  project: {
    id: string;
    number: string;
    name: string;
    client: string | null;
    kind: 'contract' | 'budget';
  } | null;
}

export type BreakdownPart =
  | 'material'
  | 'labour'
  | 'equipment'
  | 'subcontract'
  | 'other'
  | 'additions'
  | 'provisional'
  | 'not_analysed';

export interface CostSummary {
  asOf: string;
  boq: ReportBoq;
  counts: { items: number; priced: number; unpriced: number; noQty: number; analysed: number };
  sections: { code: string | null; description: string; amount: string; pct: string | null }[];
  unsectioned: { amount: string; items: number };
  kinds: {
    provisional: { items: number; amount: string };
    rateOnly: { items: number; priced: number };
    alternates: { items: number; value: string };
  };
  currencies: { code: string; rate: string; items: number; foreignValue: string; value: string }[];
  breakdown: {
    total: string;
    parts: { part: BreakdownPart; amount: string; pct: string | null }[];
  };
  incomplete: { code: string; description: string; missing: string[] }[];
  bid: {
    scenario: string;
    base: string;
    markups: { label: string; kind: string; pct: string | null; amount: string }[];
    markupTotal: string;
    beforeGst: string;
    gst: string;
    gstMode: 'add' | 'included' | 'exempt';
    bid: string;
    vsEstimatePct: string | null;
  } | null;
  pricingHidden: boolean;
}

export interface AnalysisReport {
  asOf: string;
  boq: ReportBoq;
  analyses: {
    id: string;
    code: string;
    description: string;
    unit: string;
    outputQty: string;
    direct: boolean;
    items: number;
    qty: string | null;
    lines: {
      lineNo: number;
      kind: 'resource' | 'analysis' | 'lump_sum';
      code: string | null;
      description: string;
      unit: string | null;
      qty: string | null;
      wastagePct: string | null;
      unitCost: string | null;
      cost: string;
    }[];
    subtotal: string;
    additions: { label: string; pct: string; amount: string }[];
    total: string;
    unitRate: string;
    boqRate: string;
    missing: string[];
    error: string | null;
  }[];
}

export interface PipelineRow {
  id: string;
  number: string;
  title: string;
  client: string | null;
  vertical: string;
  status: TenderStatus;
  owner: string | null;
  estimatedValue: string | null;
  emdAmount: string | null;
  submissionDueAt: string | null;
  fy: string;
  ourBid: string | null;
  resultOn: string | null;
  awardedValue: string | null;
  awardedTo: string | null;
}

export interface Pipeline {
  asOf: string;
  years: string[];
  owners: { id: string; name: string }[];
  rows: PipelineRow[];
  stages: { status: TenderStatus; count: number; estimatedValue: string }[];
  totals: {
    tenders: number;
    open: number;
    pipelineValue: string;
    submittedValue: string | null;
    won: number;
    wonValue: string;
  };
  pricingHidden: boolean;
}

// --- dashboards (step 12 part 2) ---

export type DashboardName = 'tender' | 'estimation';

export interface DashboardTile {
  key: string;
  label: string;
  hint: string;
  value: string;
  kind: 'count' | 'money' | 'pct';
  detail?: string;
  tone?: 'danger' | 'warning';
  link?: string;
}

interface DashboardCommon {
  asOf: string;
  filter: { fy: string; vertical?: string; ownerId?: string };
  years: string[];
  owners: { id: string; name: string }[];
  fixed: DashboardTile[];
  tiles: DashboardTile[];
  catalogue: { key: string; label: string; hint: string }[];
  tookMs: number;
}

export interface TenderDashboardData extends DashboardCommon {
  dashboard: 'tender';
  charts: {
    stages: { status: TenderStatus; count: number; estimatedValue: string }[];
    quarters: { quarter: string; submitted: number; won: number; lost: number; wonValue: string }[];
    verticals: { vertical: string; open: number; won: number; lost: number }[];
    upcoming: {
      at: string;
      kind: 'submission' | 'prebid' | 'queries' | 'opening' | 'security';
      label: string;
      tender: { id: string; number: string; title: string };
    }[];
    rfqs: {
      id: string;
      number: string;
      title: string;
      dueOn: string | null;
      vendors: number;
      quoted: number;
      tender: { id: string; number: string };
    }[];
  };
}

export interface EstimationDashboardData extends DashboardCommon {
  dashboard: 'estimation';
  charts: {
    estimators: {
      id: string | null;
      name: string;
      boqs: number;
      value: string;
      unpriced: number;
    }[];
    topBoqs: {
      id: string;
      name: string;
      total: string;
      versionNo: number;
      tender: { id: string; number: string; title: string };
    }[];
    revisions: {
      id: string;
      name: string;
      tenderNumber: string;
      versions: number;
      first: string;
      latest: string;
      current: string;
      changePct: string | null;
    }[];
    breakdown: CostSummary['breakdown'];
    rateChanges: {
      code: string;
      name: string;
      unit: string;
      rate: string;
      previous: string | null;
      effectiveFrom: string;
      changePct: string | null;
    }[];
  };
}

// --- BOQ templates (step 13) ---

export interface BoqTemplate {
  id: string;
  name: string;
  vertical: string;
  description: string;
  withQuantities: boolean;
  withRates: boolean;
  lineCount: number;
  itemCount: number;
  archivedAt: string | null;
  updatedAt: string;
  rowVersion: number;
  createdBy: string | null;
}

// --- projects (Wave 2a step 1) ---

export type ProjectStatus = 'planned' | 'active' | 'on_hold' | 'completed' | 'closed' | 'cancelled';
export type ProjectRole = 'lead' | 'member' | 'viewer';

export interface ProjectSummary {
  id: string;
  number: string;
  name: string;
  status: ProjectStatus;
  clientRef: string | null;
  location: string | null;
  contractValue: string | null;
  startOn: string | null;
  plannedFinishOn: string | null;
  updatedAt: string;
  client: { id: string; name: string } | null;
  lead: { id: string; displayName: string } | null;
}

export interface ProjectSite {
  id: string;
  name: string;
  address: string | null;
  stateCode: string | null;
  active: boolean;
  rowVersion: number;
}

export interface ProjectMember {
  userId: string;
  displayName: string;
  username: string;
  role: ProjectRole;
  addedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  statusReason: string | null;
  actualFinishOn: string | null;
  description: string;
  rowVersion: number;
  createdAt: string;
  tenderId: string | null;
  tender: { id: string; number: string; title: string } | null;
  entity: { id: string; name: string };
  sites: ProjectSite[];
  team: ProjectMember[];
  events: {
    id: string;
    kind: string;
    data: Record<string, unknown>;
    at: string;
    actor: string | null;
  }[];
  myRole: ProjectRole | null;
  canEdit: boolean;
  allowedMoves: ProjectStatus[];
}

// --- a project's BOQs (docs/wave2a-plan.md step 2) ---

export interface ProjectBoq {
  id: string;
  name: string;
  kind: 'contract' | 'budget';
  status: 'draft' | 'locked' | 'submitted';
  versionNo: number;
  total: string;
  nodeCount: number;
  itemCount: number;
  sourceBoqId: string | null;
  sourceVersionNo: number | null;
  sourceName?: string | null;
  rateBasis: { factor: string; scale: string; residual?: string; unsubmitted?: boolean } | null;
  archivedAt: string | null;
}

export interface BoqCopyState {
  status: 'copying' | 'done' | 'failed';
  matchContractValue: boolean;
  result: {
    scale: string;
    contractTotal: string;
    budgetTotal: string;
    residual: string | null;
  } | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BoqCopyPreview {
  tenderId: string | null;
  copied: boolean;
  copy: BoqCopyState | null;
  sources: {
    id: string;
    name: string;
    version: number;
    submitted: boolean;
    factor: string;
    quotedTotal: string;
    estimateTotal: string;
  }[];
  contractValue: string | null;
  quotedTotal: string;
  estimateTotal: string;
  /** Multiplies normal items' quoted rates to meet the contract value; null without one. */
  scale: string | null;
}

export interface BoqSummary {
  contractValue: string | null;
  contract: string;
  budget: string;
  contracts: number;
  budgets: number;
  margin: string | null;
  marginPct: string | null;
  boqs: {
    contractId: string;
    name: string;
    contract: string;
    budgetId: string | null;
    budget: string | null;
    margin: string | null;
    lines: {
      code: string | null;
      description: string;
      contract: string;
      budget: string | null;
      margin: string | null;
    }[];
  }[];
}

// --- WBS and cost codes (docs/wave2a-plan.md step 3) ---

export type CostKind = 'material' | 'labour' | 'equipment' | 'subcontract' | 'overhead' | 'other';

export interface CostCode {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  kind: CostKind;
  active: boolean;
  rowVersion: number;
  /** BOQ lines mapped to it, in every project. */
  lines: number;
  depth: number;
}

export interface WbsNode {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  position: number;
  rowVersion: number;
  /** BOQ lines mapped to it directly. */
  lines: number;
  depth: number;
}

interface Rolled {
  contract: string;
  budget: string;
  margin: string;
  /** Contract BOQ items under it (its children's included). */
  contractLines: number;
}

export interface ProjectBreakdown {
  totals: Record<'contract' | 'budget', { lines: number; amount: string }>;
  unmapped: Record<
    'wbs' | 'costCode',
    Record<'contract' | 'budget', { lines: number; amount: string }>
  >;
  wbs: (WbsNode & Rolled)[];
  costCodes: (Pick<CostCode, 'id' | 'parentId' | 'code' | 'name' | 'kind' | 'active' | 'depth'> &
    Rolled)[];
}
