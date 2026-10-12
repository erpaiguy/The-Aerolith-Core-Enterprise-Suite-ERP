// The reporting model (docs/wave6-plan.md step 3): fixed, reviewed SQL sources over each module and their fields. A
// report can only ever name these views and fields; nothing from the browser reaches the SQL text. A view with a
// project column is limited to the projects the person may see; a view may also need a permission.
import type { Permission } from '../auth/permissions.js';

export type FieldType = 'text' | 'number' | 'money' | 'date' | 'month';
export interface Field {
  label: string;
  type: FieldType;
  /** May be grouped by (text, date and month fields usually). */
  group?: boolean;
  /** May be summed or averaged (numbers and money). */
  sum?: boolean;
}
export interface View {
  label: string;
  /** A SELECT whose columns are the fields' names, plus `project_id` when `projectScoped`. */
  source: string;
  fields: Record<string, Field>;
  projectScoped: boolean;
  needs?: Permission;
}

const t = (label: string, group = true): Field => ({ label, type: 'text', group });
const d = (label: string): Field => ({ label, type: 'date', group: true });
const m = (label: string): Field => ({ label, type: 'month', group: true });
const money = (label: string): Field => ({ label, type: 'money', sum: true });
const n = (label: string): Field => ({ label, type: 'number', sum: true });

export const VIEWS: Record<string, View> = {
  projects: {
    label: 'Projects',
    projectScoped: true,
    source: `
      SELECT p.id AS project_id, p.number, p.name, p.status, c.name AS client, p.location,
        p.contract_value, p.start_on, p.planned_finish_on, to_char(p.start_on, 'YYYY-MM') AS start_month
      FROM proj.project p LEFT JOIN platform.party c ON c.id = p.client_id`,
    fields: {
      number: t('Project number', false),
      name: t('Project', false),
      status: t('Status'),
      client: t('Client'),
      location: t('Location'),
      contract_value: money('Contract value'),
      start_on: d('Start'),
      planned_finish_on: d('Planned finish'),
      start_month: m('Start month'),
    },
  },
  purchase_orders: {
    label: 'Purchase and work orders',
    projectScoped: true,
    source: `
      SELECT o.project_id, p.number AS project, o.number, o.kind, v.name AS vendor, o.status,
        o.created_at::date AS ordered_on, to_char(o.created_at, 'YYYY-MM') AS ordered_month,
        coalesce(x.value, 0) AS value, coalesce(x.gst, 0) AS gst
      FROM proc.purchase_order o JOIN proj.project p ON p.id = o.project_id JOIN platform.party v ON v.id = o.party_id
      LEFT JOIN LATERAL (
        SELECT sum(l.amount) AS value, sum(l.cgst + l.sgst + l.igst) AS gst FROM proc.po_line l
        WHERE l.revision_id = (SELECT r.id FROM proc.po_revision r WHERE r.po_id = o.id AND r.status = 'approved'
          ORDER BY r.revision DESC LIMIT 1)) x ON true`,
    fields: {
      project: t('Project'),
      number: t('Order', false),
      kind: t('Kind'),
      vendor: t('Vendor'),
      status: t('Status'),
      ordered_on: d('Ordered on'),
      ordered_month: m('Month ordered'),
      value: money('Value before GST'),
      gst: money('GST'),
    },
  },
  goods_receipts: {
    label: 'Goods receipts',
    projectScoped: true,
    source: `
      SELECT g.project_id, p.number AS project, g.number, o.number AS order_number, v.name AS vendor, g.received_on,
        to_char(g.received_on, 'YYYY-MM') AS received_month, g.status, g.challan_no
      FROM proc.goods_receipt g JOIN proj.project p ON p.id = g.project_id
      JOIN proc.purchase_order o ON o.id = g.po_id JOIN platform.party v ON v.id = o.party_id`,
    fields: {
      project: t('Project'),
      number: t('Receipt', false),
      order_number: t('Order'),
      vendor: t('Vendor'),
      received_on: d('Received on'),
      received_month: m('Month received'),
      status: t('Status'),
      challan_no: t('Challan', false),
    },
  },
  vendor_bills: {
    label: 'Supplier bills',
    projectScoped: true,
    needs: 'accounts.view',
    source: `
      SELECT b.project_id, p.number AS project, v.name AS vendor, b.bill_no, b.bill_date,
        to_char(b.bill_date, 'YYYY-MM') AS bill_month, b.due_date, b.status, b.taxable, b.cgst + b.sgst + b.igst AS gst,
        b.total, b.tds
      FROM acc.vendor_bill b LEFT JOIN proj.project p ON p.id = b.project_id JOIN platform.party v ON v.id = b.party_id`,
    fields: {
      project: t('Project'),
      vendor: t('Supplier'),
      bill_no: t('Bill', false),
      bill_date: d('Bill date'),
      bill_month: m('Bill month'),
      due_date: d('Due'),
      status: t('Status'),
      taxable: money('Taxable'),
      gst: money('GST'),
      total: money('Total'),
      tds: money('TDS'),
    },
  },
  client_bills: {
    label: 'RA bills to clients',
    projectScoped: true,
    source: `
      SELECT b.project_id, p.number AS project, c.name AS client, b.ra_no, b.upto, to_char(b.upto, 'YYYY-MM') AS upto_month,
        b.status, coalesce((b.certified ->> 'gross')::numeric, (b.submitted ->> 'gross')::numeric, 0) AS gross,
        coalesce((b.certified ->> 'net')::numeric, (b.submitted ->> 'net')::numeric, 0) AS net, b.certified_on
      FROM acc.client_bill b JOIN proj.project p ON p.id = b.project_id LEFT JOIN platform.party c ON c.id = p.client_id`,
    fields: {
      project: t('Project'),
      client: t('Client'),
      ra_no: n('RA number'),
      upto: d('Measured to'),
      upto_month: m('Month'),
      status: t('Status'),
      gross: money('Gross'),
      net: money('Net'),
      certified_on: d('Certified on'),
    },
  },
  ledger_lines: {
    label: 'Ledger lines',
    projectScoped: false,
    needs: 'accounts.view',
    source: `
      SELECT v.voucher_date, to_char(v.voucher_date, 'YYYY-MM') AS month, v.type, v.number, a.code AS account_code,
        a.name AS account, g.name AS account_group, p.number AS project, l.debit, l.credit, l.debit - l.credit AS net
      FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id JOIN acc.account a ON a.id = l.account_id
      LEFT JOIN acc.account g ON g.id = a.parent_id LEFT JOIN proj.project p ON p.id = l.project_id`,
    fields: {
      voucher_date: d('Date'),
      month: m('Month'),
      type: t('Voucher type'),
      number: t('Voucher', false),
      account_code: t('Account code'),
      account: t('Account'),
      account_group: t('Group'),
      project: t('Project'),
      debit: money('Debit'),
      credit: money('Credit'),
      net: money('Debit less credit'),
    },
  },
  leads: {
    label: 'CRM leads',
    projectScoped: false,
    source: `
      SELECT l.number, l.title, coalesce(p.name, l.organisation) AS client, l.source, l.segment,
        CASE WHEN t.status = 'won' THEN 'won' WHEN t.status IN ('lost', 'no_bid', 'withdrawn', 'cancelled') THEN 'lost'
          WHEN t.id IS NOT NULL THEN 'tender' ELSE l.stage END AS stage,
        l.value, to_char(l.expected_month, 'YYYY-MM') AS expected_month, u.display_name AS owner,
        l.created_at::date AS created_on
      FROM crm.lead l LEFT JOIN platform.party p ON p.id = l.party_id LEFT JOIN tender.tender t ON t.id = l.tender_id
      JOIN platform."user" u ON u.id = l.owner_id`,
    fields: {
      number: t('Lead', false),
      title: t('What', false),
      client: t('Client'),
      source: t('Source'),
      segment: t('Segment'),
      stage: t('Stage'),
      value: money('Value'),
      expected_month: m('Expected month'),
      owner: t('Owner'),
      created_on: d('Created on'),
    },
  },
  bookings: {
    label: 'Flat bookings',
    projectScoped: true,
    source: `
      SELECT t.project_id, p.number AS project, t.name AS tower, t.name || '-' || u.number AS unit, u.kind,
        y.name AS buyer, b.status, b.value, b.booked_on, to_char(b.booked_on, 'YYYY-MM') AS booked_month,
        coalesce((SELECT sum(base + cgst + sgst) FROM re.demand d WHERE d.booking_id = b.id), 0) AS demanded,
        coalesce((SELECT sum(amount) FROM re.receipt r WHERE r.booking_id = b.id), 0) AS received
      FROM re.booking b JOIN re.unit u ON u.id = b.unit_id JOIN re.tower t ON t.id = u.tower_id
      JOIN proj.project p ON p.id = t.project_id JOIN re.buyer y ON y.id = b.buyer_id`,
    fields: {
      project: t('Project'),
      tower: t('Tower'),
      unit: t('Unit', false),
      kind: t('Kind'),
      buyer: t('Buyer', false),
      status: t('Status'),
      value: money('Agreement value'),
      booked_on: d('Booked on'),
      booked_month: m('Month booked'),
      demanded: money('Demanded'),
      received: money('Received'),
    },
  },
  rfis: {
    label: 'RFIs',
    projectScoped: true,
    source: `
      SELECT r.project_id, p.number AS project, r.number, r.subject, u.display_name AS assigned_to, r.status, r.due_on,
        CASE WHEN r.status = 'open' AND r.due_on < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'overdue' ELSE 'on time' END
          AS timeliness,
        r.raised_at::date AS raised_on, to_char(r.raised_at, 'YYYY-MM') AS raised_month
      FROM dms.rfi r JOIN proj.project p ON p.id = r.project_id JOIN platform."user" u ON u.id = r.assigned_to`,
    fields: {
      project: t('Project'),
      number: t('RFI', false),
      subject: t('Subject', false),
      assigned_to: t('Assigned to'),
      status: t('Status'),
      due_on: d('Due'),
      timeliness: t('On time or overdue'),
      raised_on: d('Raised on'),
      raised_month: m('Month raised'),
    },
  },
};
