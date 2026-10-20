// What's new in each release (docs/wave9-plan.md step 9b.2), newest first, summarised from the Progress lists of
// docs/wave7-plan.md, docs/wave8-plan.md and docs/wave9-plan.md. Add an entry here with each release.

export interface ReleaseNote {
  version: string;
  title: string;
  summary: string;
  /** Headings, each with what changed under it. */
  sections: { heading: string; items: string[] }[];
}

export const WHATS_NEW: ReleaseNote[] = [
  {
    version: '0.9.0',
    title: 'Wave 9: the interface, and production readiness',
    summary:
      'One look across every screen, feedback you can see, and what a business needs to run the app every day: settings in one place, help, legal terms and updates.',
    sections: [
      {
        heading: 'A consistent interface',
        items: [
          'One set of colours, type and spacing in light and dark themes, checked for contrast.',
          'A message after every save, post or send; a question before anything that cannot be undone; error messages that say what to do, with a reference to quote to support.',
          'A welcome after sign-in, a warning before an idle session ends, and a check before signing out with site entries still to send.',
          'A warning before leaving a form with unsaved changes, in the browser and the desktop app.',
          'Favourites and recent pages in the menu; a status bar with the company, year, connection, outbox and version.',
          'Data grids that let you choose, resize, reorder and freeze columns, save views and export to Excel, remembered for you.',
          'One chart style on every dashboard, with a table view of each chart.',
          'A strip on documents that move through stages, showing where this one stands with links to the ones before and after.',
          'Every action reachable from the keyboard, with visible focus and labels on every control.',
        ],
      },
      {
        heading: 'Production readiness',
        items: [
          'Settings in one place: you, this device, and the company.',
          'Help for every screen (press ? or F1), a help centre, keyboard shortcuts, this list, and a support request with diagnostics.',
          'Privacy policy, terms of service, terms and conditions and licence terms, accepted at first sign-in.',
          'Updates from a signed release channel, with a notice in the status bar.',
        ],
      },
    ],
  },
  {
    version: '0.8.0',
    title: 'Wave 8: close the real gaps',
    summary:
      'Money that leaked or was misstated, tax and labour compliance, and the site, stores and sales gaps.',
    sections: [
      {
        heading: 'Money',
        items: [
          'Revenue on work done (Ind AS 115), posted each month.',
          'Material at site and month-end accruals.',
          'Free-issue material to subcontractors, with back-charges for the excess.',
          'Budget check on purchase orders.',
          'Debit notes proposed from the stores.',
        ],
      },
      {
        heading: 'Tax',
        items: [
          'GST reverse charge and Rule 37 reversal.',
          'GST TDS by government clients (GSTR-7A).',
          'TDS returns (26Q, 24Q), lower-deduction certificates, Form 16A.',
          'MSME suppliers: the 45-day alert and the 43B(h) report.',
          'TDS on flat buyers’ payments (194-IA).',
        ],
      },
      {
        heading: 'Labour and payroll',
        items: [
          'Contract labour compliance: PF, ESI and licences checked before bills are paid.',
          'Labour muster from a phone, with place and photo, working offline.',
          'Statutory challans and returns; Form 16 Part B.',
          'Overtime, bonus, loans and advances, tax declarations.',
          'Leave approved by the reporting manager, with delegation while away.',
        ],
      },
      {
        heading: 'Site and projects',
        items: [
          'Price escalation on CPWD 10CC indices.',
          'Look-ahead with constraints and percent plan complete.',
          'Snags, handover and defect liability.',
          'Geotagged photos and offline site entry.',
          'Deviation statement.',
        ],
      },
      {
        heading: 'Purchase, stores and sales',
        items: [
          'Vendor master with approval, blacklisting and KYC.',
          'Delivery follow-up and lead times.',
          'Receipts and transfers as they really happen: tolerance, vehicle, e-way bill, transit loss, central stores.',
          'Last purchase rate and stock ageing.',
          'Scrap sales and returnable tools.',
          'Booking life after sale: cancellation, transfer, registration, possession.',
          'Schedule-of-rates tendering.',
        ],
      },
      {
        heading: 'Platform',
        items: [
          'Two-factor sign-in for staff.',
          'Backups, restore and audit export.',
          'A daily email of what is overdue or expiring.',
          'Custom roles and finer permissions.',
          'Marathi and Hindi on the site screens.',
        ],
      },
    ],
  },
  {
    version: '0.7.0',
    title: 'Wave 7: find, move, print and close the loops',
    summary:
      'Getting around faster, the paper the business needs, the loops between site, stores and books closed, and new registers.',
    sections: [
      {
        heading: 'Find and move',
        items: [
          'Parties with kind filters; one list of enquiries (RFQs).',
          'Company-wide registers: daily reports, bills, drawings, RFIs, inspections, NCRs, stock issues and transfers.',
          'The project workspace in the menu, with a project picker.',
          'A "New" menu for the common forms.',
          'Search everything with Ctrl+K.',
          'My work on Home.',
          'The audit trail.',
        ],
      },
      {
        heading: 'Paper',
        items: [
          'Company letterhead.',
          'Printable purchase orders, work orders, goods receipts and issue slips.',
          'Printable RA bills, client receipts, payment advices and payslips.',
          'Transmittals and HR letters.',
          'Monthly MIS pack, client progress report, RERA cost sheet and demand letter.',
        ],
      },
      {
        heading: 'Close the loops',
        items: [
          'Daily reports proposed into the measurement book.',
          'Material reconciliation and estimate against actual.',
          'Orders made from requisitions; rate contracts.',
          'Month-end close checklist.',
          'Salary increments in bulk.',
          'Excel imports for parties, employees, contract workers and resources.',
        ],
      },
      {
        heading: 'New registers',
        items: [
          'Meetings and actions; correspondence; master document list.',
          'Inspection and test plans; safety inspections.',
          'Site imprest; recurring entries; joining and exit checklists.',
          'Company dashboard.',
        ],
      },
    ],
  },
];
