// In-app help, one topic per screen (docs/wave9-plan.md step 9b.2): what the screen is for, the common task as steps,
// the fields that need explaining, and related screens. Keyed by the router's path pattern ('$name' for a part of
// the address that changes); the Help panel shows the topic of the current page and the Help centre lists them all.

export type HelpGroup =
  | 'Getting started'
  | 'Business development'
  | 'Estimation'
  | 'Projects'
  | 'Project workspace'
  | 'Documents and design'
  | 'Procurement and stores'
  | 'People'
  | 'Accounts'
  | 'Reports'
  | 'Administration'
  | 'Your account';

/** The order the Help centre lists the groups in: the menu's order. */
export const HELP_GROUPS: HelpGroup[] = [
  'Getting started',
  'Business development',
  'Estimation',
  'Projects',
  'Project workspace',
  'Documents and design',
  'Procurement and stores',
  'People',
  'Accounts',
  'Reports',
  'Administration',
  'Your account',
];

export interface HelpField {
  name: string;
  meaning: string;
}

export interface HelpTopic {
  /** The router's path pattern, e.g. '/orders/$orderId'. */
  route: string;
  group: HelpGroup;
  title: string;
  /** What the screen is for, in one or two sentences. */
  purpose: string;
  /** The common task, step by step. */
  steps: string[];
  fields?: HelpField[];
  /** Other topics' routes. */
  related?: string[];
}

export const TOPICS: HelpTopic[] = [
  // --- Getting started ---
  {
    route: '/',
    group: 'Getting started',
    title: 'Home',
    purpose:
      'Your starting page: the work that waits on you, your inbox of notices, your own reminders and the state of the licence.',
    steps: [
      'Look at My work: approvals, RFIs to answer, bills to certify, orders to receive, NCRs, meeting actions and follow-ups.',
      'Click a line to open the record it is about.',
      'Read the inbox; unread notices are in bold.',
      'To be reminded of something, type it in "Remind me to", choose when, and press Add reminder.',
    ],
    fields: [
      { name: 'Remind me to', meaning: 'What you want to be reminded of. Only you see it.' },
      { name: 'When', meaning: 'The day and time the reminder comes due.' },
    ],
    related: ['/approvals', '/outbox'],
  },
  {
    route: '/approvals',
    group: 'Getting started',
    title: 'Approvals',
    purpose:
      'Requisitions, orders, bills and other documents waiting for your decision, and the ones you sent or decided. You can also name someone to stand in for you while you are away.',
    steps: [
      'Open "Waiting on me" to see what needs your decision.',
      'Click a request to read the document and its levels.',
      'Approve it with a note, reject it with a reason, or add a comment.',
      'Going on leave? Under "Standing in while away", add a stand-in with the dates.',
    ],
    fields: [
      { name: 'Approver away', meaning: 'The person who will be away.' },
      { name: 'Stands in', meaning: 'Who decides in their place between the two dates.' },
    ],
    related: ['/approvals/$approvalId', '/settings/approvals'],
  },
  {
    route: '/approvals/$approvalId',
    group: 'Getting started',
    title: 'An approval request',
    purpose:
      'One request as the approver sees it: the document, the amount, each approval level and what has happened so far.',
    steps: [
      'Read the document summary and the amount.',
      'Check the levels: who has approved and who is next.',
      'Approve (with a note if you like) or reject with a reason. A comment asks a question without deciding.',
      'The person who sent it can withdraw it from here.',
    ],
    related: ['/approvals', '/settings/approvals'],
  },
  {
    route: '/outbox',
    group: 'Getting started',
    title: 'Outbox',
    purpose:
      'Forms saved on this phone while there was no signal. They are sent in order as soon as the signal returns.',
    steps: [
      'Check what is waiting; the oldest is sent first.',
      'If one was refused, read the reason, put it right on its own screen, then discard the refused copy here.',
      'Do not sign out while entries are waiting unless you mean to: they stay on this device until you sign in here again.',
    ],
    related: ['/daily-reports/$reportId', '/labour/muster', '/hr/me'],
  },
  {
    route: '/help',
    group: 'Getting started',
    title: 'Help centre',
    purpose:
      'Help for every screen, the keyboard shortcuts, what is new in each release, the legal terms and a way to ask for support.',
    steps: [
      'Type in the search box to find a screen or a task.',
      'Open a topic to read what the screen is for and the steps.',
      'Press ? or F1 on any page for the help of that page.',
      'Use Get support to write to support with the details they need.',
    ],
  },

  // --- Business development ---
  {
    route: '/dashboards/tender',
    group: 'Business development',
    title: 'Bid dashboard',
    purpose:
      'Tenders and bids at a glance: the pipeline by stage, bids won and lost by quarter, what is due in the next 30 days and the enquiries out.',
    steps: [
      'Choose the financial year, vertical or owner at the top.',
      'Read the three headline numbers, then your own tiles and the charts.',
      'Click a tile or a bar to open the tenders it counts.',
      'Add tiles from the catalogue with "Add a tile"; they are kept for you.',
      'Download the figures as Excel, or print the page to save it as PDF.',
    ],
    related: ['/tenders', '/tenders/win-loss', '/dashboards/estimation'],
  },
  {
    route: '/crm',
    group: 'Business development',
    title: 'CRM',
    purpose:
      'Leads before they become tenders: who, what, when and how likely; the pipeline, follow-ups due and leads going cold.',
    steps: [
      'Add a lead with the client, what it is for, its value and the expected month.',
      'Log each call, visit or email as an interaction, with the next step and a follow-up date.',
      'Move the lead through its stages; mark it lost with a reason, or convert it to a tender.',
      'Keep the client’s people under Contacts.',
    ],
    fields: [
      { name: 'Value (₹)', meaning: 'What the work is expected to be worth.' },
      {
        name: 'Expected month',
        meaning: 'When you expect the tender or order; the pipeline weighs value by stage.',
      },
      { name: 'Follow up on', meaning: 'The date the lead shows under Follow-ups.' },
    ],
    related: ['/tenders', '/clients'],
  },
  {
    route: '/clients',
    group: 'Business development',
    title: 'Parties',
    purpose:
      'Clients, suppliers, subcontractors and competitors: one record each, used across tenders, projects and the books. Suppliers and Subcontractors in the menu open this list filtered.',
    steps: [
      'Search by name, or filter by kind of party.',
      'Add a party with its name, GSTIN, PAN, contact and address.',
      'For suppliers, fill the TDS section, reverse charge, MSME and bank details used by payables.',
      'Edit a party to change its details; the change shows everywhere it is used.',
    ],
    fields: [
      { name: 'GSTIN', meaning: 'GST number. Its first two digits are the state code.' },
      { name: 'TDS section', meaning: 'The section tax is deducted under when paying this party.' },
      {
        name: 'GST reverse charge',
        meaning: 'Tick when we, not the supplier, pay the GST on what they supply.',
      },
      {
        name: 'MSME (Udyam)',
        meaning: 'A registered micro or small enterprise must be paid within 45 days.',
      },
    ],
    related: ['/vendors', '/crm', '/settings/imports'],
  },
  {
    route: '/sales',
    group: 'Business development',
    title: 'Sales and RERA',
    purpose:
      'A real-estate project’s units by tower and floor, bookings with their demands and receipts, the payment plan by construction milestone, and the RERA designated account.',
    steps: [
      'Choose the project. Add towers and units under Sales setup.',
      'Set the payment plan: the milestones and the share due at each.',
      'Click a free unit to book it to a buyer.',
      'On the booking, register the agreement, raise demands and record receipts.',
      'After the sale: record the sale deed, hand over, transfer to a nominee, or cancel the booking.',
    ],
    fields: [
      { name: 'Carpet m²', meaning: 'Carpet area of the unit, as RERA defines it.' },
      { name: '26QB acknowledgement', meaning: 'The buyer’s 1% TDS filing for this payment.' },
    ],
  },
  {
    route: '/portal-users',
    group: 'Business development',
    title: 'Portal users',
    purpose:
      'Vendors, subcontractors and clients who sign in to the portals to see their own orders, bills and documents. They are free and are not seats.',
    steps: [
      'Press Invite, choose the portal and the party, and give the person’s name and email.',
      'Send them the invitation link shown.',
      'Deactivate someone who should no longer sign in.',
    ],
    related: ['/portal-submissions', '/clients'],
  },
  {
    route: '/portal-submissions',
    group: 'Business development',
    title: 'Portal submissions',
    purpose:
      'Quotes, measurements and invoices sent through the portals. Nothing counts until it is accepted here.',
    steps: [
      'Open a submission waiting for a decision.',
      'Check it against the order or the work done.',
      'Accept it, or reject it with the reason the sender will see.',
    ],
    related: ['/portal-users'],
  },

  // --- Estimation ---
  {
    route: '/tenders',
    group: 'Estimation',
    title: 'Tenders',
    purpose: 'Every tender from lead to won or lost, as a list or a calendar of the dates.',
    steps: [
      'Filter by status or search by name.',
      'Press New tender to add one; only the title is needed at first.',
      'Open a tender to record the bid/no-bid decision, its dates, documents, BOQ and enquiries.',
      'Switch the view to see the agenda of submission and pre-bid dates.',
    ],
    related: ['/tenders/new', '/tenders/$tenderId', '/tenders/win-loss', '/dashboards/tender'],
  },
  {
    route: '/tenders/new',
    group: 'Estimation',
    title: 'New tender',
    purpose: 'Starts a tender. Only the title is required; add the rest as you learn it.',
    steps: [
      'Type the title.',
      'Add the client, dates and values you know.',
      'Save. Deadline reminders follow the dates you entered.',
    ],
    fields: [
      { name: 'EMD', meaning: 'Earnest money deposit asked by the client.' },
      { name: 'Bid validity', meaning: 'How long the price must hold after submission.' },
    ],
    related: ['/tenders'],
  },
  {
    route: '/tenders/$tenderId',
    group: 'Estimation',
    title: 'A tender',
    purpose:
      'One tender: its details and dates, the bid/no-bid decision, documents, BOQs, enquiries to vendors, the programme and its activity.',
    steps: [
      'Fill the bid/no-bid criteria and record the decision.',
      'Keep the dates current: submission, pre-bid, queries, opening.',
      'Add the BOQ, price it, and send enquiries for the rates you need.',
      'When the result is known, mark it won or lost (with the reason). A won tender becomes a project from here.',
    ],
    fields: [
      { name: 'Submission due', meaning: 'The last date and time to hand in the bid.' },
      { name: 'Estimated value', meaning: 'The client’s estimate, if published.' },
    ],
    related: ['/boqs/$boqId', '/rfqs/$rfqId', '/projects'],
  },
  {
    route: '/tenders/win-loss',
    group: 'Estimation',
    title: 'Win / loss',
    purpose:
      'Tenders handed in, by the financial year they were submitted: win rate, results by client and vertical, competitors head to head, and why we lost.',
    steps: [
      'Choose the financial year.',
      'Read the win rate by count and by value.',
      'Look at the competitors and the reasons for losses to adjust the next bid.',
    ],
    related: ['/tenders', '/dashboards/tender'],
  },
  {
    route: '/rfqs',
    group: 'Estimation',
    title: 'Enquiries (RFQs)',
    purpose:
      'Every request for quotation, from tenders and from projects, in one list for estimation and purchase.',
    steps: [
      'Filter by status or by where it came from.',
      'Open an enquiry to send it, record the quotes and compare them.',
    ],
    related: ['/rfqs/$rfqId', '/requisitions'],
  },
  {
    route: '/rfqs/$rfqId',
    group: 'Estimation',
    title: 'An enquiry (RFQ)',
    purpose:
      'One enquiry: its lines, the vendors asked, their quotes, the comparative statement and the choice per line.',
    steps: [
      'Add lines from the BOQ, approved requisitions, resources, or type them.',
      'Add the vendors to ask, then download each one’s Excel enquiry and send it from your email.',
      'When a quote comes back, import the filled file or type the rates in.',
      'Compare the quotes, choose a vendor per line (or the lowest on every line), and put the rates into the estimate or make the orders.',
    ],
    fields: [
      { name: 'Quotes due by', meaning: 'The date vendors are asked to reply by.' },
      { name: 'L1 split', meaning: 'Each line goes to the vendor lowest on that line.' },
    ],
    related: ['/rfqs', '/orders', '/vendors'],
  },
  {
    route: '/boq-templates',
    group: 'Estimation',
    title: 'BOQ templates',
    purpose:
      'The company’s standard BOQs per vertical, to start a tender’s BOQ from. A template is saved from a BOQ’s own page.',
    steps: [
      'To make one, open a BOQ and choose "Save this BOQ as a template".',
      'Here, rename a template, change its vertical, or archive one no longer used.',
      'When a tender gets a new BOQ, choose the template to start from.',
    ],
    related: ['/boqs/$boqId'],
  },
  {
    route: '/boqs/$boqId',
    group: 'Estimation',
    title: 'A BOQ',
    purpose:
      'A bill of quantities: sections and items with quantities, units and rates, edited like a spreadsheet.',
    steps: [
      'Move around with the arrow keys; Enter or F2 edits a cell, Esc cancels.',
      'Ctrl+Enter adds an item, Ctrl+Shift+Enter a section; Alt+Shift+arrows indent or move rows.',
      'Link items to rate analyses, and re-price every linked item as on a date.',
      'Freeze a version before submitting; open Versions to revise and compare.',
    ],
    related: ['/boqs/$boqId/pricing', '/boqs/$boqId/versions', '/rate-analyses', '/boq-templates'],
  },
  {
    route: '/boqs/$boqId/pricing',
    group: 'Estimation',
    title: 'Bid pricing',
    purpose:
      'Scenarios of markups and GST on a BOQ, the comparison with the client’s estimate, the price per section, and item rates for an item-rate submission.',
    steps: [
      'Add a scenario and its markups: overheads, profit, contingency, escalation or discount.',
      'Choose how GST applies.',
      'Compare the bid with the client’s estimate and look at the price per section.',
      'Export the quoted rates for an item-rate submission.',
    ],
    fields: [
      { name: 'Applies to', meaning: 'Which part of the cost a markup is added to.' },
      {
        name: 'Items without a rate',
        meaning: 'Items still to be priced; the bid is short by them.',
      },
    ],
    related: ['/boqs/$boqId', '/boqs/$boqId/versions'],
  },
  {
    route: '/boqs/$boqId/versions',
    group: 'Estimation',
    title: 'BOQ versions',
    purpose:
      'Freeze a version, start the next revision, see every version with the bid it carried, and compare two line by line.',
    steps: [
      'Freeze the current BOQ with a label and the reason.',
      'Choose two versions under Compare versions to see lines added, removed and changed.',
      'Export any version.',
    ],
    related: ['/boqs/$boqId'],
  },
  {
    route: '/resources',
    group: 'Estimation',
    title: 'Resources',
    purpose:
      'The rate library: materials, labour, equipment and subcontract rates, with the date each rate applies from.',
    steps: [
      'Search for a resource, or press Add resource.',
      'Open one to see its rate history and add a new rate from a date.',
      'To bring in many rates, import a price book: check it first, then apply.',
    ],
    fields: [
      {
        name: 'Rate from',
        meaning: 'The first day the rate applies. Older rates stay in the history.',
      },
      { name: 'Rates as on', meaning: 'Shows each resource at the rate in force on that day.' },
    ],
    related: ['/rate-analyses', '/settings/imports'],
  },
  {
    route: '/sor-books',
    group: 'Estimation',
    title: 'Schedules of rates',
    purpose:
      'Your copies of the CPWD DSR or a state PWD SOR, for estimates priced from the schedule and percentage-rate tenders. None is shipped with the app.',
    steps: [
      'Press Add schedule with its name, issuer and edition.',
      'Upload its spreadsheet: Code, Description, Unit, Rate, and Chapter if any.',
      'Find an item by code or words; BOQ items can cite it.',
    ],
    related: ['/boqs/$boqId', '/resources'],
  },
  {
    route: '/rate-analyses',
    group: 'Estimation',
    title: 'Rate analyses',
    purpose:
      'Item rates built from resources, other analyses, wastage, overheads and profit, costed as on a date.',
    steps: [
      'Search the list, or start a new analysis.',
      'Open one to add lines and see the rate worked out.',
      'Set "Rates as on" to cost every analysis at the rates of that day.',
    ],
    related: ['/rate-analyses/$analysisId', '/resources'],
  },
  {
    route: '/rate-analyses/$analysisId',
    group: 'Estimation',
    title: 'A rate analysis',
    purpose: 'One item’s rate, built line by line, with where it is used.',
    steps: [
      'Add lines: a resource, another analysis, or a lump sum.',
      'Give each line its quantity and wastage %.',
      'Add overheads and profit as percentages.',
      'Copy the analysis under a new code to make a variant.',
    ],
    fields: [
      { name: 'Analysis for', meaning: 'The quantity the lines make, e.g. 1 m³ or 10 m².' },
      { name: 'Wastage %', meaning: 'Added to the line’s quantity before costing.' },
    ],
    related: ['/rate-analyses', '/boqs/$boqId'],
  },
  {
    route: '/cost-codes',
    group: 'Estimation',
    title: 'Cost codes',
    purpose:
      'The company’s cost codes, in groups, each of a kind of cost. Projects map their BOQ lines to them for cost control.',
    steps: [
      'Start from the standard list, or add codes one by one.',
      'Place each code under its group and choose its kind.',
      'Retire a code you no longer use; codes are never deleted.',
    ],
    related: ['/projects/$projectId/wbs', '/cost-control'],
  },
  {
    route: '/dashboards/estimation',
    group: 'Estimation',
    title: 'Estimation dashboard',
    purpose:
      'BOQs in progress by estimator, the largest of them and what they are made of, enquiries awaiting quotes, revisions and rate changes in 30 days.',
    steps: [
      'Choose the financial year, vertical or owner.',
      'Click a figure to open what it counts.',
      'Add your own tiles; download the figures as Excel or print the page.',
    ],
    related: ['/dashboards/tender', '/rfqs'],
  },

  // --- Projects ---
  {
    route: '/projects',
    group: 'Projects',
    title: 'Projects',
    purpose: 'Jobs won and under way. A won tender becomes a project from the tender’s page.',
    steps: [
      'Filter by status or search by name.',
      'Press New project to add one that did not come from a tender.',
      'Open a project to work in it: the menu then shows that project’s sections.',
    ],
    fields: [
      {
        name: 'Work order / agreement number',
        meaning: 'The client’s reference for the contract.',
      },
      { name: 'Contract value (₹)', meaning: 'The value of the work as agreed.' },
    ],
    related: ['/projects/$projectId', '/portfolio'],
  },
  {
    route: '/portfolio',
    group: 'Projects',
    title: 'Portfolio',
    purpose: 'Every project on one page: margin, performance, cash, variations, claims and risks.',
    steps: [
      'Read across a project’s row to see where it stands.',
      'Click a project to open its monthly review.',
    ],
    related: ['/monthly-review', '/cost-control', '/earned-value'],
  },
  {
    route: '/monthly-review',
    group: 'Projects',
    title: 'Monthly review',
    purpose:
      'One project’s month on one page, from cost to risks: cost planned, actual and forecast; earned value; cash; variations; contract dates; risks. Ready to print.',
    steps: [
      'Choose the project and the month.',
      'Read each section.',
      'Press Print for the meeting.',
    ],
    related: ['/portfolio'],
  },
  {
    route: '/cost-control',
    group: 'Projects',
    title: 'Cost control',
    purpose:
      'For a project: budget, committed, actual, cost to complete, forecast and variance by cost code and WBS element.',
    steps: [
      'Choose the project and the month.',
      'Look at "Needs attention" for the lines going over.',
      'Enter the cost to complete where the computed one is wrong.',
      'Place costs that are not yet allocated to a WBS element and cost code.',
    ],
    fields: [
      { name: 'Committed', meaning: 'Orders placed but not yet billed.' },
      { name: 'Cost to complete', meaning: 'What is still to be spent to finish the line.' },
      { name: 'Forecast', meaning: 'Actual plus committed plus cost to complete.' },
    ],
    related: ['/earned-value', '/cash-flow', '/cost-codes'],
  },
  {
    route: '/cash-flow',
    group: 'Projects',
    title: 'Cash flow',
    purpose:
      'A project’s, or the company’s, money in and out by month or week: actual for the past, forecast ahead, with the running position.',
    steps: [
      'Choose whose cash flow, by month or week, and the date.',
      'Set the project’s cash terms (how fast clients pay, retention, client TDS) so the forecast is right.',
      'For the company, enter the monthly overheads not booked to projects.',
    ],
    related: ['/cost-control', '/accounts/receivables', '/accounts/payables'],
  },
  {
    route: '/earned-value',
    group: 'Projects',
    title: 'Earned value',
    purpose:
      'Planned value from the baseline, earned value from the measurement book, actual cost from the books: how the project is doing and where it will finish.',
    steps: [
      'Choose the project and the date.',
      'Read the indices: below 1 means behind or over cost.',
      'Compare the estimates at completion and look at each WBS element.',
    ],
    fields: [
      { name: 'CPI', meaning: 'Earned value over actual cost: cost performance.' },
      { name: 'SPI', meaning: 'Earned value over planned value: schedule performance.' },
    ],
    related: ['/cost-control', '/projects/$projectId/progress'],
  },
  {
    route: '/variations',
    group: 'Projects',
    title: 'Variations',
    purpose:
      'Changes to the contract: raised and priced, approved inside and by the client, and carried into the BOQ and budget.',
    steps: [
      'Choose the project and press Raise a variation.',
      'Say what changed and why, with the instruction reference, and add its lines.',
      'Submit it for approval, then record the client’s decision with the allowed quantities and rates.',
      'Watch the register for work started but not yet approved.',
    ],
    related: ['/contracts', '/projects/$projectId'],
  },
  {
    route: '/contracts',
    group: 'Projects',
    title: 'Contracts and claims',
    purpose:
      'For a project: the contracts with their securities, obligations and notices, extensions of time and claims, with a calendar of dated duties.',
    steps: [
      'Add the contract and its securities (bank guarantees and the like) with their validity.',
      'Record obligations and notices with their due dates; they show on the calendar.',
      'Claim an extension of time from the hindrances in the daily reports.',
      'Add claims and record the settled amount.',
    ],
    related: ['/variations', '/risks'],
  },
  {
    route: '/risks',
    group: 'Projects',
    title: 'Risk register',
    purpose:
      'Risks by score and expected value, their mitigation, and the contingency held against them, for a project or the company.',
    steps: [
      'Raise a risk with its cause, effect, probability and impact.',
      'Add mitigation actions with owners.',
      'Set the contingency held; draw on it when a risk occurs.',
      'Use the heat map to see where the open risks sit.',
    ],
    related: ['/contracts', '/portfolio'],
  },
  {
    route: '/quality',
    group: 'Projects',
    title: 'Quality',
    purpose:
      'For a project: inspection requests, checklists, tests against their criteria, NCRs, snags, handovers, defects and material approvals; and the company’s checklist templates.',
    steps: [
      'Choose a project.',
      'Request an inspection before work is covered; bills take only inspected work when the hold is on.',
      'Fill a checklist or record a test; a failed one raises an NCR.',
      'Record snags and handovers, and defects reported in the liability period.',
    ],
    related: ['/registers/inspections', '/registers/ncrs', '/projects/$projectId/itp'],
  },
  {
    route: '/registers/inspections',
    group: 'Projects',
    title: 'Inspections',
    purpose: 'Requests for inspection and their decisions, across projects.',
    steps: [
      'Filter by project, status or dates, or search.',
      'Click a row to open it on the project’s Quality page.',
    ],
    related: ['/quality'],
  },
  {
    route: '/registers/ncrs',
    group: 'Projects',
    title: 'NCRs',
    purpose: 'Non-conformance reports and their closure, across projects.',
    steps: ['Filter by project, status or dates.', 'Click a row to open the NCR.'],
    related: ['/quality'],
  },
  {
    route: '/safety',
    group: 'Projects',
    title: 'Safety',
    purpose:
      'For a project: incidents investigated to closure, permits to work, toolbox talks, safety inspections and the injury rates from recorded man-hours.',
    steps: [
      'Choose a project.',
      'Report an incident, then record the investigation and root cause, and close it.',
      'Ask for a permit to work; it is issued before work starts and closed after.',
      'Record toolbox talks with the topic and who attended.',
    ],
    related: ['/projects/$projectId/site-walks', '/quality'],
  },
  {
    route: '/mep',
    group: 'Projects',
    title: 'MEP',
    purpose:
      'System-wise BOQ templates and testing and commissioning checklists; per project, the equipment schedule and the clash log.',
    steps: [
      'Load the MEP pack once for the company.',
      'Choose a project and add its equipment with tag, system and capacity.',
      'Commission equipment on a passed T&C checklist.',
      'Raise clashes between systems and track them to closure.',
    ],
    related: ['/quality'],
  },
  {
    route: '/registers/daily-reports',
    group: 'Projects',
    title: 'Daily reports (all projects)',
    purpose: 'Every site’s daily report, across projects.',
    steps: ['Filter by project, status or dates.', 'Click a row to open the report.'],
    related: ['/daily-reports/$reportId', '/projects/$projectId/daily-reports'],
  },
  {
    route: '/daily-reports/$reportId',
    group: 'Projects',
    title: 'A daily report',
    purpose:
      'A day’s site report, made for a phone: weather, manpower, equipment, work done, material, hindrances, photos, safety and notes. Saved as you go, even without signal.',
    steps: [
      'Fill each section as the day goes; changes are kept on the phone and sent when there is signal.',
      'Add photos; they keep the place and time they were taken.',
      'Record hindrances with their cause and hours lost.',
      'Submit at the end of the day. The engineer acknowledges it or sends it back for correction.',
    ],
    related: ['/projects/$projectId/daily-reports', '/outbox'],
  },
  {
    route: '/programmes/$planId',
    group: 'Projects',
    title: 'A schedule',
    purpose:
      'A tender’s programme or a project’s schedule: activities beside the bar chart, worked out again on every change.',
    steps: [
      'Add activities with their duration and predecessors; Insert adds, Delete removes.',
      'Alt+Shift+right and left indent and outdent; arrow keys move between rows.',
      'On a project schedule, record progress as of a date and take a baseline.',
      'Link activities to BOQ items and resources to see what is needed week by week.',
    ],
    related: ['/programmes/$planId/make-ready', '/projects/$projectId/macro'],
  },
  {
    route: '/programmes/$planId/make-ready',
    group: 'Projects',
    title: 'Look-ahead and weekly plan',
    purpose:
      'What the coming work waits for, what the site commits to each week, and how much of it got done (percent plan complete).',
    steps: [
      'Add constraints to coming activities: drawings, material, front, approvals or labour, with who clears them and by when.',
      'Commit the week’s work from what is ready.',
      'At the week’s end mark each commitment done, or say why it was missed.',
    ],
    related: ['/programmes/$planId'],
  },
  {
    route: '/material-budgets/$budgetId',
    group: 'Projects',
    title: 'Material budget',
    purpose:
      'One revision of a project’s material budget: each resource’s quantity and rate, against the revision before and what requisitions already take.',
    steps: [
      'Change quantities and rates while the revision is being worked on.',
      'Say why the revision is made.',
      'Save, then submit it for approval. Once in force it is kept as it was.',
    ],
    related: ['/projects/$projectId', '/requisitions'],
  },

  // --- Project workspace ---
  {
    route: '/projects/$projectId',
    group: 'Project workspace',
    title: 'A project',
    purpose:
      'One project’s page: its details and status, BOQs, programme, material budget, requisitions, enquiries, orders, stores, daily reports, client bills, sites and team.',
    steps: [
      'Use the project’s sections in the menu to jump to each part of the page.',
      'Make the contract BOQ and budget from the won tender under BOQs.',
      'Raise requisitions, write orders and set up stores from their sections.',
      'Add sites and the team; only the team (and roles that see every project) see the project.',
    ],
    fields: [
      {
        name: 'Project status',
        meaning: 'Planned, active, on hold, completed, closed or cancelled.',
      },
    ],
    related: ['/projects/$projectId/dashboard', '/projects/$projectId/wbs', '/projects'],
  },
  {
    route: '/projects/$projectId/dashboard',
    group: 'Project workspace',
    title: 'Project dashboard',
    purpose:
      'Where the project stands on one page: the money, each schedule against its baseline, the S-curve, the next two weeks and the next milestones. Printable.',
    steps: ['Read the figures; each links to where it is kept.', 'Press Print to save it as PDF.'],
    related: ['/projects/$projectId', '/earned-value'],
  },
  {
    route: '/projects/$projectId/wbs',
    group: 'Project workspace',
    title: 'WBS and cost codes',
    purpose:
      'The contract and the budget broken down by WBS element and by cost code, and what is not mapped yet.',
    steps: [
      'Make the WBS from a BOQ’s sections, or add elements by hand.',
      'Map BOQ lines in the BOQ itself: select lines, then Map.',
      'Check the unmapped total falls to nothing.',
    ],
    related: ['/cost-codes', '/projects/$projectId/macro'],
  },
  {
    route: '/projects/$projectId/macro',
    group: 'Project workspace',
    title: 'Macro plan',
    purpose:
      'The live schedules rolled up through the WBS: a bar per element against its baseline, progress and slip; the milestones; and the same by package, trade and zone.',
    steps: [
      'Choose a view: by WBS, milestones, package, trade or zone.',
      'Look for elements whose finish has slipped.',
    ],
    related: ['/programmes/$planId', '/projects/$projectId/wbs'],
  },
  {
    route: '/projects/$projectId/progress',
    group: 'Project workspace',
    title: 'Progress (measurement)',
    purpose:
      'Work done as measured in the contract BOQ’s measurement books, at contract rates; physical progress; and the same work at budget rates.',
    steps: [
      'Choose the period.',
      'Read the value done to date and in the period, by BOQ section and by WBS.',
      'Look at items measured beyond their BOQ quantity: they may need a variation.',
      'Download as Excel.',
    ],
    related: ['/variations', '/earned-value'],
  },
  {
    route: '/projects/$projectId/daily-reports',
    group: 'Project workspace',
    title: 'Project daily reports',
    purpose:
      'Today’s report for each site, the days with none, and the weekly figures: man-days by trade, equipment hours and hindrances by cause.',
    steps: [
      'Choose a site or all sites.',
      'Open today’s report to fill it, or a past one to read it.',
      'Check the days with no submitted report.',
    ],
    related: ['/daily-reports/$reportId', '/registers/daily-reports'],
  },
  {
    route: '/projects/$projectId/consumption',
    group: 'Project workspace',
    title: 'Consumption',
    purpose:
      'Material budgeted, received and issued for the project, by material and by WBS element.',
    steps: [
      'Read each material’s budget against what was received and issued.',
      'Switch to By WBS to see where it went.',
    ],
    related: ['/stores', '/projects/$projectId/procurement-reports'],
  },
  {
    route: '/projects/$projectId/procurement-reports',
    group: 'Project workspace',
    title: 'Project procurement reports',
    purpose:
      'Requisition to order to receipt, open orders, material reconciliation with wastage against the norms, and supplier performance, for this project.',
    steps: ['Open a report.', 'Download it as Excel if you need to work on it.'],
    related: ['/procurement-reports'],
  },
  {
    route: '/projects/$projectId/imprest',
    group: 'Project workspace',
    title: 'Site imprest',
    purpose:
      'Petty-cash floats held by the project team: advances paid in, spends entered by the holder, and settlement into the books.',
    steps: [
      'Accounts opens an imprest for a holder, with a float limit if any.',
      'Pay an advance into it.',
      'The holder enters each spend with its bill or reference.',
      'Accounts settles the spends into the books and takes back what is left.',
    ],
    related: ['/accounts/vouchers'],
  },
  {
    route: '/projects/$projectId/meetings',
    group: 'Project workspace',
    title: 'Meetings',
    purpose:
      'A project’s minutes, decisions and the actions agreed, each with an owner and a date. Owners see their actions in My work.',
    steps: [
      'Press Record a meeting: title, date, place and attendees.',
      'Write the minutes and decisions.',
      'Add actions with an owner from the team and a date.',
      'Owners close their actions when done.',
    ],
    related: ['/'],
  },
  {
    route: '/projects/$projectId/letters',
    group: 'Project workspace',
    title: 'Correspondence',
    purpose:
      'A project’s letters in and out, with references, the letter each answers, replies owed by a date, and the scan from the project’s documents.',
    steps: [
      'Add a letter: in or out, date, their reference, subject and gist.',
      'Set "Reply needed by" when an answer is owed.',
      'Link the scan from the project’s documents.',
    ],
    related: ['/projects/$projectId/documents'],
  },
  {
    route: '/projects/$projectId/document-list',
    group: 'Project workspace',
    title: 'Document list',
    purpose:
      'The drawings, approvals and certificates the project expects, from whom and by when. Anything still to come after its date is late.',
    steps: [
      'Press Expect documents, or paste many lines (code, title, from, due date).',
      'Mark each received with its date and the file.',
      'Watch the late ones.',
    ],
    related: ['/projects/$projectId/documents', '/registers/drawings'],
  },
  {
    route: '/projects/$projectId/itp',
    group: 'Project workspace',
    title: 'Inspection and test plan',
    purpose:
      'The project’s activities, each with the checklist and test it needs, how often, who checks and whether it is a hold point; beside each, what has been done.',
    steps: [
      'The project lead adds an activity to the plan.',
      'Choose its checklist, test, frequency and who checks.',
      'Compare the plan with the quality records shown beside it.',
    ],
    related: ['/quality'],
  },
  {
    route: '/projects/$projectId/site-walks',
    group: 'Project workspace',
    title: 'Safety inspections',
    purpose:
      'Site walks with the safety checklist, what they found, who is to put each finding right and by when, and its closure.',
    steps: [
      'Press Record a site walk: area, date and who walked.',
      'Add findings with severity, what to do, an owner and a date.',
      'Owners close their findings, saying what was done.',
    ],
    related: ['/safety'],
  },
  {
    route: '/projects/$projectId/documents',
    group: 'Project workspace',
    title: 'Project documents and drawings',
    purpose:
      'The project’s vault: folders, uploads with versions, preview, tags, the trash and ZIP downloads, with revision control for drawings.',
    steps: [
      'Choose a folder, or make one.',
      'Upload files or a whole folder; a new file with the same name becomes a new version.',
      'Open a document to preview it, tag it or download any version.',
      'Deleted documents go to the trash, where they can be brought back.',
    ],
    related: ['/documents', '/transmittals', '/reviews'],
  },

  // --- Documents and design ---
  {
    route: '/documents',
    group: 'Documents and design',
    title: 'Documents',
    purpose: 'Searches the documents of every tender and project you can see.',
    steps: [
      'Type words from the name or description, or choose a tag.',
      'Open a result to preview or download it.',
    ],
    related: ['/projects/$projectId/documents'],
  },
  {
    route: '/reviews',
    group: 'Documents and design',
    title: 'Reviews',
    purpose:
      'Document reviews in stages: reviewers answer with a code, and the worst code at a stage decides.',
    steps: [
      'See what is waiting on you and respond with a code and comment.',
      'To start a review, choose the project, the document and the workflow.',
      'Set up workflows: stages, who decides, and the days to answer.',
    ],
    related: ['/transmittals', '/sign-offs'],
  },
  {
    route: '/transmittals',
    group: 'Documents and design',
    title: 'Transmittals and RFIs',
    purpose:
      'What went out and came back, the questions from site, and what was sent for approval. Overdue items are in red.',
    steps: [
      'New transmittal: choose the documents, the recipient and the days to respond; issue it and share the link.',
      'Record the answer when it comes back.',
      'Raise an RFI with the question, drawing and location; answer it and link the revised drawing.',
      'Send a submittal for approval through a review workflow.',
    ],
    related: ['/registers/rfis', '/reviews'],
  },
  {
    route: '/registers/drawings',
    group: 'Documents and design',
    title: 'Drawings',
    purpose: 'Every drawing received, its latest revision and purpose, across projects.',
    steps: ['Filter by project, discipline or dates.', 'Click a row to open the drawing.'],
    related: ['/drawing-receipts', '/projects/$projectId/documents'],
  },
  {
    route: '/registers/rfis',
    group: 'Documents and design',
    title: 'RFIs',
    purpose: 'Requests for information from site, across projects.',
    steps: ['Filter by project, status or dates.', 'Click a row to open it.'],
    related: ['/transmittals'],
  },
  {
    route: '/sign-offs',
    group: 'Documents and design',
    title: 'Sign-offs',
    purpose: 'Documents signed in order with drawn signatures, each with an audit certificate.',
    steps: [
      'Draw your signature once under My signature; it is kept to reuse.',
      'New sign-off: upload the PDF, add signers in order and place each one’s field on the page.',
      'When it is your turn, sign or decline with a reason.',
      'The signed version comes with its certificate.',
    ],
    related: ['/reviews'],
  },
  {
    route: '/drawing-receipts',
    group: 'Documents and design',
    title: 'Drawing receipts',
    purpose:
      'New drawing revisions sent to you by the distribution matrix. Acknowledge each once the old prints are withdrawn.',
    steps: ['Open each new revision.', 'Withdraw the old prints on site.', 'Acknowledge it.'],
    related: ['/registers/drawings'],
  },

  // --- Procurement and stores ---
  {
    route: '/requisitions',
    group: 'Procurement and stores',
    title: 'Requisitions',
    purpose:
      'What the projects you are on ask to be bought. A requisition is raised from a project’s page.',
    steps: [
      'Choose what to show.',
      'Open a requisition to see it, or raise one from the project’s Requisitions section.',
    ],
    related: ['/requisitions/$requisitionId', '/rfqs', '/orders'],
  },
  {
    route: '/requisitions/$requisitionId',
    group: 'Procurement and stores',
    title: 'A requisition',
    purpose:
      'What the project asks to be bought, line by line, sent for approval. A draft can be changed; once submitted it waits on its approvers.',
    steps: [
      'Add lines: what, unit, quantity, the BOQ item or WBS it is for.',
      'Save, then submit it for approval.',
      'To change a submitted one, withdraw it first.',
      'Once approved, start an enquiry or an order from it.',
    ],
    fields: [{ name: 'Needed by', meaning: 'The date the material must be on site.' }],
    related: ['/requisitions', '/rfqs/$rfqId', '/orders/$orderId'],
  },
  {
    route: '/orders',
    group: 'Procurement and stores',
    title: 'Orders',
    purpose:
      'Purchase and work orders of the projects you are on. Write one from a project’s page, or make them from the vendors chosen in an enquiry.',
    steps: ['Choose what to show.', 'Open an order to see it, amend it or record what came.'],
    related: ['/orders/$orderId', '/receipts', '/deliveries'],
  },
  {
    route: '/orders/$orderId',
    group: 'Procurement and stores',
    title: 'An order',
    purpose:
      'A purchase or work order: to whom, what, at what rate, GST, delivered where and when, on what terms. Changed as a draft and sent for approval; printed for the supplier.',
    steps: [
      'Fill the lines, delivery and terms, then save and submit it.',
      'A line over the budget needs a reason before it goes on.',
      'After issue, print it, record the supplier’s acknowledgement, and record goods receipts against it.',
      'Amend it as a new revision, or cancel or close it.',
    ],
    fields: [
      { name: 'Rate ₹', meaning: 'Before GST; GST is added on top at the GST %.' },
      { name: 'HSN/SAC', meaning: 'The GST code of the goods or service.' },
    ],
    related: ['/orders', '/receipts/$receiptId', '/accounts/vendor-bills/new'],
  },
  {
    route: '/orders/revision/$revisionId',
    group: 'Procurement and stores',
    title: 'An order revision',
    purpose: 'One revision of an order, as it was issued.',
    steps: ['Read the revision.', 'Go back to the order to see the one in force.'],
    related: ['/orders/$orderId'],
  },
  {
    route: '/vendors',
    group: 'Procurement and stores',
    title: 'Vendor master',
    purpose:
      'Every supplier and subcontractor with its trade categories, approved or blacklisted status with the reason, and KYC documents with their expiry.',
    steps: [
      'Filter by trade category or status.',
      'Open a vendor to set its status and categories and add KYC documents.',
      'A blacklisted or held vendor cannot be sent enquiries or orders.',
    ],
    related: ['/vendors/$partyId', '/clients'],
  },
  {
    route: '/vendors/$partyId',
    group: 'Procurement and stores',
    title: 'A vendor',
    purpose: 'One vendor’s details, status, trade categories and KYC documents.',
    steps: [
      'Set the status (approved, held or blacklisted) with the reason.',
      'Tick its trade categories.',
      'Add KYC documents with their number, validity and a scan.',
    ],
    related: ['/vendors'],
  },
  {
    route: '/rate-contracts',
    group: 'Procurement and stores',
    title: 'Rate contracts',
    purpose:
      'Rates agreed with suppliers for a period, perhaps up to a quantity. Orders from requisitions to the supplier take them.',
    steps: [
      'Press New rate contract: supplier, reference and dates.',
      'Add a rate per material, before GST, with an optional quantity cap.',
      'See what has been ordered against each line.',
    ],
    related: ['/orders', '/resources'],
  },
  {
    route: '/deliveries',
    group: 'Procurement and stores',
    title: 'Delivery follow-up',
    purpose:
      'Deliveries overdue, with the last date the supplier promised, and how long buying takes from requisition to receipt, by supplier.',
    steps: [
      'Chase the overdue deliveries.',
      'Use the lead times when planning the next requisition.',
    ],
    related: ['/orders', '/receipts'],
  },
  {
    route: '/receipts',
    group: 'Procurement and stores',
    title: 'Goods receipts',
    purpose:
      'What came against the purchase orders of the projects you are on. A receipt is recorded from the order’s page.',
    steps: ['Choose what to show.', 'Open a receipt to inspect, return or print it.'],
    related: ['/receipts/$receiptId', '/orders'],
  },
  {
    route: '/receipts/$receiptId',
    group: 'Procurement and stores',
    title: 'A goods receipt',
    purpose:
      'What came against an order, on which challan, at which site: each line accepted at the gate or held for inspection.',
    steps: [
      'Record the inspection of held lines: accepted or rejected with the reason.',
      'Return rejected goods to the supplier.',
      'Print the receipt. Cancel it with a reason only if it was made in error.',
    ],
    related: ['/orders/$orderId', '/accounts/debit-note-proposals'],
  },
  {
    route: '/stores',
    group: 'Procurement and stores',
    title: 'Stores',
    purpose:
      'Stores across your projects, central stores not tied to a project, and the stock valuation method.',
    steps: [
      'Open a store to see its stock.',
      'Add a central store (a yard) if you keep one.',
      'Choose the valuation method; it is fixed once stock first moves.',
    ],
    fields: [
      { name: 'Stock valuation', meaning: 'Weighted average, or first in, first out (FIFO).' },
    ],
    related: ['/stores/$storeId', '/stock-ageing'],
  },
  {
    route: '/stores/$storeId',
    group: 'Procurement and stores',
    title: 'A store',
    purpose:
      'What is in one store and what it is worth, each material’s ledger, issues to work, transfers, reorder levels and the stock take.',
    steps: [
      'Issue material to work, naming the BOQ item or WBS element (and a work order for free issue).',
      'Transfer to another store with the vehicle and e-way bill.',
      'Set reorder levels; make a requisition for what is short.',
      'Count stock in a stock take.',
    ],
    related: ['/stores', '/registers/stock-issues', '/registers/stock-transfers'],
  },
  {
    route: '/issues/$issueId',
    group: 'Procurement and stores',
    title: 'A stock issue',
    purpose: 'An issue slip: material given out to work, and what came back from site.',
    steps: ['Check the lines.', 'Record what came back.', 'Print the slip.'],
    related: ['/registers/stock-issues'],
  },
  {
    route: '/transfers/$transferId',
    group: 'Procurement and stores',
    title: 'A stock transfer',
    purpose:
      'Material moved between stores: received at the other end, or cancelled while in transit.',
    steps: ['At the receiving store, record what arrived; any shortfall is a transit loss.'],
    related: ['/registers/stock-transfers'],
  },
  {
    route: '/stock-counts/$countId',
    group: 'Procurement and stores',
    title: 'A stock take',
    purpose: 'A count of a store: counted, approved and posted to the stock.',
    steps: [
      'Enter the counted quantities.',
      'Send it for approval.',
      'Once approved, post the differences.',
    ],
    related: ['/stores/$storeId'],
  },
  {
    route: '/stock-ageing',
    group: 'Procurement and stores',
    title: 'Stock ageing',
    purpose:
      'Stock by how long it has lain, and what has not been issued for three months: money tied up on the shelf.',
    steps: [
      'Look at the oldest stock by store and material.',
      'Transfer or use what has not moved.',
    ],
    related: ['/stores'],
  },
  {
    route: '/scrap-tools',
    group: 'Procurement and stores',
    title: 'Scrap and tools',
    purpose:
      'Scrap noted on site and sold with GST; returnable tools issued to a person or gang, with what is overdue, back or lost.',
    steps: [
      'Choose the project. Note scrap as it arises, then sell it to a buyer.',
      'Issue a tool with who has it and the date it is due back.',
      'Mark it back, or lost with how.',
    ],
    related: ['/stores'],
  },
  {
    route: '/registers/stock-issues',
    group: 'Procurement and stores',
    title: 'Stock issues',
    purpose: 'Material issued from stores to work, across projects.',
    steps: ['Filter by project or dates.', 'Click a row to open the issue slip.'],
    related: ['/stores'],
  },
  {
    route: '/registers/stock-transfers',
    group: 'Procurement and stores',
    title: 'Stock transfers',
    purpose: 'Material moved between stores, across projects.',
    steps: ['Filter by project, status or dates.', 'Click a row to open the transfer.'],
    related: ['/stores'],
  },
  {
    route: '/procurement-reports',
    group: 'Procurement and stores',
    title: 'Procurement reports',
    purpose:
      'Across the projects you are on: open orders and what suppliers still owe, and supplier performance. A project’s own page has four more.',
    steps: ['Open a report.', 'Download it as Excel.'],
    related: ['/projects/$projectId/procurement-reports', '/deliveries'],
  },

  // --- People ---
  {
    route: '/hr/me',
    group: 'People',
    title: 'My attendance',
    purpose:
      'Mark yourself in and out with the phone’s location, see your week, and apply for leave.',
    steps: [
      'Allow the page to use your location, then press Mark in (and Mark out at the end of the day).',
      'See your leave balances.',
      'Apply for leave with the dates and reason; withdraw it while it waits.',
    ],
    related: ['/hr/leave/$leaveId', '/outbox'],
  },
  {
    route: '/hr/register',
    group: 'People',
    title: 'Site attendance',
    purpose: 'A site’s attendance register for the project team, marked by the site in charge.',
    steps: [
      'Choose the project, site and day.',
      'Mark each person in or out, with a note if needed.',
      'Save the register.',
    ],
    related: ['/hr', '/labour/muster'],
  },
  {
    route: '/hr',
    group: 'People',
    title: 'Employees',
    purpose:
      'The employees, each month’s days for payroll, leave applications, a biometric device’s file, and the setup: designations, holiday calendars, sites and leave types.',
    steps: [
      'Add an employee with code, name, kind and joining date; open one for the full record.',
      'Check the month’s days before payroll.',
      'Decide leave applications.',
      'Import punches from a biometric device’s file.',
    ],
    related: ['/hr/employees/$employeeId', '/payroll', '/settings/imports'],
  },
  {
    route: '/hr/employees/$employeeId',
    group: 'People',
    title: 'An employee',
    purpose:
      'One employee’s record, where they work, their leave, letters and joining or exit checklist. PAN and bank are shown in full only to HR.',
    steps: [
      'Edit the record and save.',
      'Deploy them to a project and site from a date.',
      'Print letters: appointment, increment, relieving, experience.',
    ],
    related: ['/hr', '/payroll'],
  },
  {
    route: '/hr/leave/$leaveId',
    group: 'People',
    title: 'A leave application',
    purpose: 'One leave application, where approvals link to.',
    steps: [
      'Read the dates and reason.',
      'Approve or reject it from Approvals, or cancel it here.',
    ],
    related: ['/hr/me', '/approvals'],
  },
  {
    route: '/payroll',
    group: 'People',
    title: 'Payroll',
    purpose:
      'The monthly runs, the compliance rules (PF, ESI, PT, LWF) and pay components; your own payslips and Form 16 data.',
    steps: [
      'Press New run and choose the month.',
      'Open the run: work the month, add arrears and deductions, check the totals.',
      'Send it for approval, post it, and pay the net with the bank’s file.',
      'Print payslips.',
    ],
    related: ['/payroll/runs/$runId', '/payroll/increments', '/hr'],
  },
  {
    route: '/payroll/runs/$runId',
    group: 'People',
    title: 'A payroll run',
    purpose: 'One month’s pay: worked, adjusted, approved, posted and paid.',
    steps: [
      'Work the month from attendance and salaries.',
      'Add arrears or deductions for anyone.',
      'Approve and post it to the books.',
      'Record the payment from the bank, and the statutory challans.',
    ],
    related: ['/payroll'],
  },
  {
    route: '/payroll/increments',
    group: 'People',
    title: 'Increments',
    purpose:
      'Everyone in service, their salary now, and the increment from a date: reviewed, then applied together as new salaries.',
    steps: [
      'Choose the date the increments apply from.',
      'Type one percentage for everyone, or a percentage per person.',
      'Check the sheet, then press Apply the increments.',
    ],
    related: ['/payroll'],
  },
  {
    route: '/labour',
    group: 'People',
    title: 'Contract labour',
    purpose:
      'Labour contractors and their licences, their workers, minimum wages, monthly wage sheets checked and verified as paid, and BOCW cess.',
    steps: [
      'Pick a supplier as a labour contractor and record their CLRA licence.',
      'Add their workers with trade, skill and daily wage.',
      'Work the month’s wage sheet; it is checked against the minimum wage.',
      'Verify it as paid. Pay BOCW cess by project.',
    ],
    related: ['/labour/muster', '/labour/wage-sheets/$sheetId'],
  },
  {
    route: '/labour/wage-sheets/$sheetId',
    group: 'People',
    title: 'A wage sheet',
    purpose:
      'A contractor’s month for one site: days, wages, PF and ESI, checked against the minimum wage.',
    steps: ['Check each worker’s days and wage.', 'Record the payment and verify it as paid.'],
    related: ['/labour'],
  },
  {
    route: '/labour/muster',
    group: 'People',
    title: 'Labour muster',
    purpose:
      'The day’s muster of contract workers on a site, marked from the phone with its place and a photo of the gang; works without signal.',
    steps: [
      'Choose the project, site, contractor and day.',
      'Mark each worker present, absent or half day, with overtime.',
      'Add a photo of the gang and save the muster.',
    ],
    related: ['/labour', '/outbox'],
  },

  // --- Accounts ---
  {
    route: '/accounts/vouchers',
    group: 'Accounts',
    title: 'Vouchers',
    purpose: 'Every voucher of a company, filtered by type and dates.',
    steps: [
      'Choose the company, type and dates, or search.',
      'Open a voucher to read it or reverse it.',
      'Press New voucher to type one in.',
    ],
    related: ['/accounts/vouchers/new', '/accounts/day-book'],
  },
  {
    route: '/accounts/vouchers/new',
    group: 'Accounts',
    title: 'New voucher',
    purpose: 'Type a voucher in: lines of debits and credits that must balance.',
    steps: [
      'Choose the type and date; add a reference and narration.',
      'Add lines: ledger, party or project if asked, debit or credit.',
      'When the totals match, post the voucher.',
    ],
    fields: [
      { name: 'Narration', meaning: 'What the entry is for, as it will read in the books.' },
    ],
    related: ['/accounts/vouchers'],
  },
  {
    route: '/accounts/vouchers/$voucherId',
    group: 'Accounts',
    title: 'A voucher',
    purpose: 'One posted voucher. A posted voucher is never edited: it is reversed.',
    steps: ['Read the lines.', 'To undo it, press Reverse, give the date and the reason.'],
    related: ['/accounts/vouchers'],
  },
  {
    route: '/accounts/receivables',
    group: 'Accounts',
    title: 'Receivables',
    purpose: 'What each client owes, aged; bills outstanding; and the receipts.',
    steps: [
      'Choose the date to age to.',
      'Look at who owes what, and for how long.',
      'Press Record a receipt when a client pays.',
    ],
    related: ['/accounts/client-receipts/new', '/registers/client-bills'],
  },
  {
    route: '/accounts/client-receipts/new',
    group: 'Accounts',
    title: 'Record a client receipt',
    purpose:
      'A client’s payment against its certified bills, retention released or an advance, with the TDS they deducted.',
    steps: [
      'Choose the client, the date and the bank it went into.',
      'Enter the amount received and any TDS or GST TDS deducted.',
      'Allocate it to bills (Oldest bills first does it for you).',
      'Record the receipt.',
    ],
    fields: [
      { name: 'TDS deducted ₹', meaning: 'Income-tax TDS the client kept back.' },
      { name: 'GST TDS, section 51 ₹', meaning: 'The 2% a government client deducts under GST.' },
    ],
    related: ['/accounts/receivables'],
  },
  {
    route: '/accounts/client-receipts/$receiptId',
    group: 'Accounts',
    title: 'A client receipt',
    purpose: 'One receipt and what it settled. It is cancelled by reversing it.',
    steps: ['Read what it settled.', 'Print it for the client.'],
    related: ['/accounts/receivables'],
  },
  {
    route: '/accounts/payables',
    group: 'Accounts',
    title: 'Payables',
    purpose:
      'What is owed to suppliers, aged from the due dates; their bills, debit notes, advances and payment runs.',
    steps: [
      'Enter a supplier’s bill, against an order or to a ledger.',
      'Bills that do not match their order and receipts are held; see why.',
      'Make a payment run of the bills to pay, send it for approval, and mark it paid.',
    ],
    fields: [
      {
        name: 'Rate tolerance',
        meaning: 'How far a bill’s rate may differ from the order before it is held.',
      },
    ],
    related: ['/accounts/vendor-bills/new', '/accounts/payment-runs/new'],
  },
  {
    route: '/accounts/vendor-bills/new',
    group: 'Accounts',
    title: 'Enter a supplier bill',
    purpose: 'A supplier’s bill, matched to its order and receipts, or booked to a ledger.',
    steps: [
      'Choose the supplier and, if it is against an order, the order.',
      'Type their bill number, bill date and due date.',
      'Check the lines and GST, and the TDS section.',
      'Enter the bill. If it does not match, it is held with the reason.',
    ],
    related: ['/accounts/payables', '/accounts/vendor-bills/$billId'],
  },
  {
    route: '/accounts/vendor-bills/$billId',
    group: 'Accounts',
    title: 'A supplier bill',
    purpose: 'One supplier bill, what settled it, its debit notes and advances.',
    steps: ['Raise a debit note against it if needed.', 'Apply an advance paid earlier.'],
    related: ['/accounts/payables'],
  },
  {
    route: '/accounts/payment-runs/new',
    group: 'Accounts',
    title: 'New payment run',
    purpose: 'Choose the bills and advances to pay, from which bank and on what date.',
    steps: [
      'Choose the bank and payment date.',
      'Tick the bills to pay and add any advances.',
      'Make the run; it goes for approval.',
    ],
    related: ['/accounts/payables'],
  },
  {
    route: '/accounts/payment-runs/$runId',
    group: 'Accounts',
    title: 'A payment run',
    purpose: 'One approved run with the file for the bank.',
    steps: [
      'Download the bank file and upload it to your bank.',
      'Print payment advices.',
      'Mark it paid with the date.',
    ],
    related: ['/accounts/payables'],
  },
  {
    route: '/accounts/bank',
    group: 'Accounts',
    title: 'Bank',
    purpose:
      'Bank reconciliation: statements imported, each line matched to the ledger’s vouchers, and the reconciliation as at a date.',
    steps: [
      'Choose the bank ledger and import a statement (spreadsheet with a saved column mapping, OFX or MT940).',
      'Match each line to the suggested voucher, or pick one.',
      'For a line only the bank knows (charges, interest), make a voucher in one click.',
      'Read the reconciliation statement.',
    ],
    related: ['/accounts/vouchers'],
  },
  {
    route: '/registers/client-bills',
    group: 'Accounts',
    title: 'Client bills',
    purpose:
      'Running-account bills to clients, across projects. A bill is made from the project’s page.',
    steps: ['Filter by project, status or dates.', 'Click a row to open the bill.'],
    related: ['/client-bills/$billId', '/accounts/receivables'],
  },
  {
    route: '/client-bills/$billId',
    group: 'Accounts',
    title: 'A client RA bill',
    purpose:
      'A client running-account bill: previous, this bill and cumulative quantities, escalation and deductions; certified by the client, it becomes a tax invoice and posts to the books.',
    steps: [
      'While a draft, check the quantities and deductions.',
      'Submit it.',
      'Record the client’s certificate (often for less); it then posts.',
      'Print it, or download it as Excel.',
    ],
    related: ['/registers/client-bills', '/accounts/client-receipts/new'],
  },
  {
    route: '/registers/subcontract-bills',
    group: 'Accounts',
    title: 'Subcontract bills',
    purpose: 'Subcontractors’ running-account bills, across projects.',
    steps: ['Filter by project, status or dates.', 'Click a row to open the bill.'],
    related: ['/subcontract-bills/$billId'],
  },
  {
    route: '/subcontract-bills/$billId',
    group: 'Accounts',
    title: 'A subcontract RA bill',
    purpose:
      'A subcontractor’s bill on a work order: this bill’s quantities, back-charges and the deductions worked out, submitted for approval and certified into payables.',
    steps: [
      'Measure the work in the work order’s measurement book first.',
      'Check the quantities and add back-charges.',
      'Submit it for approval; once certified it goes into payables.',
    ],
    related: ['/registers/subcontract-bills', '/orders/$orderId', '/labour'],
  },
  {
    route: '/accounts/gst',
    group: 'Accounts',
    title: 'GST',
    purpose:
      'The month’s outward and inward registers, GSTR-1, the GSTR-3B summary, GSTR-2B against the purchase book, Rule 37 reversals, GST TDS, e-invoices and credit notes.',
    steps: [
      'Choose the month.',
      'Download GSTR-1 for the offline tool and read the GSTR-3B summary.',
      'Upload GSTR-2B to match it against the purchase book.',
      'Record IRNs for e-invoices and raise credit notes.',
    ],
    related: ['/accounts/tds'],
  },
  {
    route: '/accounts/tds',
    group: 'Accounts',
    title: 'TDS',
    purpose:
      'A quarter’s deductions from suppliers’ bills, the challans that deposit them, the 26Q data for the return, and what clients deducted matched against 26AS.',
    steps: [
      'Choose the quarter.',
      'Record each challan with its BSR code and serial number.',
      'Fix any 26Q problems listed, then download the return file.',
      'Upload the 26AS extract to match clients’ deductions.',
    ],
    related: ['/accounts/gst'],
  },
  {
    route: '/equipment',
    group: 'Accounts',
    title: 'Equipment',
    purpose:
      'The plant and fleet register, allocation to projects, log sheets, maintenance, fuel against the norm, and the month’s costing.',
    steps: [
      'Add a machine: own or hired, with its rate and fuel norm.',
      'Allocate it to a project and site.',
      'Enter daily log sheets: readings or hours, idle and breakdown hours.',
      'Read the month’s costing: own machines charged to projects, hire bills from the logs.',
    ],
    related: ['/accounts/assets'],
  },
  {
    route: '/accounts/assets',
    group: 'Accounts',
    title: 'Fixed assets',
    purpose:
      'The asset register, transfers and disposals, depreciation runs and the Income Tax blocks for a year.',
    steps: [
      'Register an asset from a supplier’s bill or the opening balances.',
      'Transfer it between projects, or dispose of it.',
      'Run depreciation up to a date; a run can be reversed.',
    ],
    related: ['/equipment'],
  },
  {
    route: '/accounts/statements',
    group: 'Accounts',
    title: 'Financial statements',
    purpose:
      'Profit and loss and balance sheet in Schedule III lines with the previous year, cash flow by the indirect method, each project’s P&L, and the year end.',
    steps: [
      'Choose the statement and dates.',
      'Download as Excel.',
      'At the year end, close the year with the closing stock.',
    ],
    related: ['/accounts/trial-balance'],
  },
  {
    route: '/accounts/trial-balance',
    group: 'Accounts',
    title: 'Trial balance',
    purpose: 'Every ledger’s balance as at a date, for the company or one project.',
    steps: [
      'Choose the date and, if you like, a project.',
      'Click a ledger to open it.',
      'Download as Excel.',
    ],
    related: ['/accounts/ledgers/$accountId', '/accounts/statements'],
  },
  {
    route: '/accounts/ledgers/$accountId',
    group: 'Accounts',
    title: 'A ledger',
    purpose: 'One ledger between two dates with its running balance.',
    steps: ['Choose the dates.', 'Click an entry to open its voucher.', 'Download as Excel.'],
    related: ['/accounts/trial-balance'],
  },
  {
    route: '/accounts/day-book',
    group: 'Accounts',
    title: 'Day book',
    purpose: 'Every voucher between two dates, in order.',
    steps: ['Choose the dates.', 'Download as Excel.'],
    related: ['/accounts/vouchers'],
  },
  {
    route: '/accounts/debit-note-proposals',
    group: 'Accounts',
    title: 'Debit notes to raise',
    purpose:
      'Bills for more than the stores accepted, or above the order’s rate: the debit notes the orders and stores say to raise.',
    steps: ['Check each proposal.', 'Raise the debit note in one step.'],
    related: ['/accounts/payables', '/receipts/$receiptId'],
  },
  {
    route: '/accounts/price-indices',
    group: 'Accounts',
    title: 'Price indices',
    purpose:
      'Monthly index values for price escalation. A bill’s escalation takes their average over its period.',
    steps: [
      'Add a series (WPI, CPI, steel, cement) once.',
      'Enter each month’s value as published.',
    ],
    related: ['/client-bills/$billId'],
  },
  {
    route: '/accounts/month-end-accruals',
    group: 'Accounts',
    title: 'Month-end accruals',
    purpose:
      'Costs incurred but not yet billed (goods received, subcontract work measured) and stock lying at site, posted on the month’s last day and reversed on the next month’s first.',
    steps: ['Choose the month.', 'Check each project’s figures.', 'Press Post the month.'],
    related: ['/accounts/close'],
  },
  {
    route: '/accounts/revenue-recognition',
    group: 'Accounts',
    title: 'Revenue on work done',
    purpose:
      'Ind AS 115: each project’s share complete, the revenue earned, what its bills have taken, and the difference, with any expected loss.',
    steps: [
      'Choose the company and month.',
      'Check each project.',
      'Press Post the month; it reverses on the next month’s first day.',
    ],
    related: ['/accounts/close', '/cost-control'],
  },
  {
    route: '/accounts/recurring',
    group: 'Accounts',
    title: 'Recurring entries',
    purpose:
      'Rent, hire, AMCs and accruals that come round monthly, quarterly or yearly, drafted on their due days for you to post.',
    steps: [
      'Set up a recurring entry: what, how often, on which day, amount and ledger or supplier.',
      'On the due day a draft appears under Due.',
      'Post it (a bill needs the supplier’s number) or skip it.',
    ],
    related: ['/accounts/vouchers'],
  },
  {
    route: '/accounts/close',
    group: 'Accounts',
    title: 'Month-end close',
    purpose: 'Each close step as the books show it. When all are done, the month can be locked.',
    steps: [
      'Choose the company and month.',
      'Open each step that is not done and finish it.',
      'Lock the month.',
    ],
    related: ['/accounts/month-end-accruals', '/accounts/revenue-recognition', '/accounts/setup'],
  },
  {
    route: '/accounts/chart',
    group: 'Accounts',
    title: 'Chart of accounts',
    purpose:
      'One chart of accounts for every company (balances are kept by company), and the account map that says where each kind of posting goes.',
    steps: [
      'The admin adds, renames, moves and closes accounts.',
      'In the account map, choose the ledger for each role.',
    ],
    related: ['/accounts/setup'],
  },
  {
    route: '/accounts/setup',
    group: 'Accounts',
    title: 'Books setup',
    purpose:
      'A company’s months locked and open, and the opening balances. Locks and openings are the admin’s.',
    steps: [
      'Choose the financial year; lock or open months.',
      'Upload an Excel sheet of Ledger, Debit and Credit for the opening balances; check it, then apply.',
    ],
    related: ['/accounts/chart', '/accounts/close'],
  },

  // --- Reports ---
  {
    route: '/company-dashboard',
    group: 'Reports',
    title: 'Company dashboard',
    purpose:
      'One company at a glance: order book, revenue against plan, margin by project, cash and credit, receivables over 90 days, tenders due and safety incidents.',
    steps: ['Choose the date.', 'Click a figure to open what it counts.'],
    related: ['/portfolio', '/reports'],
  },
  {
    route: '/reports',
    group: 'Reports',
    title: 'Reports',
    purpose:
      'The bid pipeline, win/loss, and for a BOQ its cost summary and the rate analyses behind it. Print them, save them as PDF, or download them as Excel.',
    steps: ['Choose a report.', 'Set its filters.', 'Print, or download Excel.'],
    related: ['/reports/builder'],
  },
  {
    route: '/reports/builder',
    group: 'Reports',
    title: 'Report builder',
    purpose:
      'Your own reports over projects, purchasing, billing, the ledger, CRM and sales: a table or a chart, saved, shared, exported and scheduled.',
    steps: [
      'Choose a view, then its fields, or a grouping with totals.',
      'Add filters and a sort.',
      'Show it as a table or a chart.',
      'Save it, share it, download Excel, or schedule it to your inbox.',
    ],
    related: ['/reports'],
  },

  // --- Administration ---
  {
    route: '/users',
    group: 'Administration',
    title: 'Users',
    purpose:
      'Who signs in and what they may do: users, roles, custom access profiles, and what each role can do.',
    steps: [
      'Press Add user: username, full name and role. Pass the one-time password shown to them; they choose their own at first sign-in.',
      'Change someone’s role or name.',
      'Make access profiles for finer permissions and give them to people.',
    ],
    related: ['/password-resets', '/settings/approvals'],
  },
  {
    route: '/password-resets',
    group: 'Administration',
    title: 'Reset requests',
    purpose: 'People who asked the admin to reset their password.',
    steps: [
      'Check the request is really from that person.',
      'Issue a one-time password and pass it on to them, or decline the request.',
      'They choose a new password at their next sign-in.',
    ],
    related: ['/users'],
  },
  {
    route: '/settings/tenders',
    group: 'Administration',
    title: 'Tender settings',
    purpose:
      'The bid/no-bid criteria and weights, the standard document checklist, the standard folders for tender documents, and how long the trash keeps documents.',
    steps: ['Edit each list.', 'Save. Until changed, the built-in lists apply.'],
    related: ['/tenders'],
  },
  {
    route: '/settings/approvals',
    group: 'Administration',
    title: 'Approval rules',
    purpose:
      'Who approves what, by amount. Nobody approves their own request, nor two levels of the same one.',
    steps: [
      'Choose the kind of document.',
      'Add levels, each from an amount upwards, and who approves at each.',
      'Save the rules. Requests already sent keep the rules they were sent under.',
    ],
    related: ['/approvals', '/users'],
  },
  {
    route: '/settings/companies',
    group: 'Administration',
    title: 'Companies',
    purpose:
      'Each company keeps its own books, GST registration and document numbers. Also each company’s letterhead for printed documents.',
    steps: [
      'Add or edit a company: name, legal name, GSTIN, PAN, TAN and address.',
      'Open Letterhead to upload the logo and set the contact details, footer and signatory.',
      'See a sample page before printing.',
    ],
    fields: [
      { name: 'GSTIN', meaning: 'Gives the state and the PAN; they must agree.' },
      { name: 'Books start on', meaning: 'The first day this company’s books are kept here.' },
    ],
    related: ['/accounts/setup'],
  },
  {
    route: '/settings/integrations',
    group: 'Administration',
    title: 'Integrations',
    purpose:
      'Keys for the public API and the Tally agent, webhooks that tell your other systems when something happens, and how far Tally has caught up.',
    steps: [
      'Make an API key; copy its secret at once, it is shown only once.',
      'Add a webhook with an https address and see its recent deliveries.',
    ],
    related: ['/backups'],
  },
  {
    route: '/backups',
    group: 'Administration',
    title: 'Backups and audit export',
    purpose:
      'The nightly backup’s hour and how many are kept, every backup with whether a restore proved it, a backup now, a download, and a ZIP of the books for auditors.',
    steps: [
      'Set the hour and how many backups to keep.',
      'Take a backup now when you need one.',
      'Download an audit export with the trial balance as of a date.',
    ],
    related: ['/settings/audit'],
  },
  {
    route: '/settings/imports',
    group: 'Administration',
    title: 'Imports',
    purpose: 'Bring in parties, employees, contract workers or resources from an Excel sheet.',
    steps: [
      'Choose what to import and the company.',
      'Choose the workbook and press Check the sheet: each row is checked first.',
      'Import; rows that cannot be saved are listed with the reason.',
    ],
    related: ['/clients', '/hr', '/resources'],
  },
  {
    route: '/settings/audit',
    group: 'Administration',
    title: 'Audit trail',
    purpose:
      'Who created, changed or removed which record, and when, with the fields changed. Newest first.',
    steps: [
      'Filter by person, kind of record, record or dates.',
      'Open an entry to see the fields changed, or the record itself.',
    ],
    related: ['/backups'],
  },

  // --- Your account ---
  {
    route: '/settings',
    group: 'Your account',
    title: 'Settings',
    purpose:
      'Your own settings (name, password, two-factor sign-in, morning email, legal documents), this device’s (language, theme, dates and amounts, updates), and for admins the company’s.',
    steps: ['Choose You, This device or Company.', 'Change what you need and save.'],
    related: ['/two-factor', '/account/password'],
  },
  {
    route: '/two-factor',
    group: 'Your account',
    title: 'Two-factor sign-in',
    purpose:
      'A code from an authenticator app at every sign-in, on top of your password. Admins and those who post to the books may be required to use it.',
    steps: [
      'Scan the code with your authenticator app.',
      'Type the six-digit code it shows to confirm.',
      'Keep the recovery codes somewhere safe; each works once if you lose the phone.',
    ],
    related: ['/settings'],
  },
  {
    route: '/account/password',
    group: 'Your account',
    title: 'Your name and password',
    purpose: 'Change the name others see, your morning email, and your password.',
    steps: ['Type your current password, then the new one twice.', 'Save.'],
    related: ['/settings'],
  },
];
