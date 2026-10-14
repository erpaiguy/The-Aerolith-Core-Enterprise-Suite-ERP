// Company-wide registers (docs/wave7-plan.md step 7a.3): the records that live inside projects (daily reports, client
// and subcontract bills, drawings, RFIs, inspections, NCRs, store issues and transfers), listed across every project a
// person can see, with project, status, date and text filters. Reading only; each row links to its own screen.
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Sql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export const REGISTERS = [
  'daily-reports',
  'client-bills',
  'subcontract-bills',
  'drawings',
  'rfis',
  'inspections',
  'ncrs',
  'stock-issues',
  'stock-transfers',
] as const;
export type Register = (typeof REGISTERS)[number];

export interface RegisterQuery {
  projectId?: string | undefined;
  status?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
}

const LIMIT = 1000;

@Injectable()
export class RegistersService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  /** The projects a person can see: all of them with `projects.all`, else those whose team they are on. */
  private visible(db: Sql, claims: TenantClaims, seesAll: boolean) {
    return seesAll
      ? db`TRUE`
      : db`p.id IN (SELECT project_id FROM proj.member WHERE user_id = ${claims.sub})`;
  }

  async list(claims: TenantClaims, kind: Register, q: RegisterQuery) {
    if (!REGISTERS.includes(kind)) throw new NotFoundException({ code: 'no_register' });
    const db = await this.tenants.forTenant(claims.ten);
    const seen = this.visible(db, claims, await this.permissions.can(claims, 'projects.all'));
    const project = q.projectId ? db`AND p.id = ${q.projectId}` : db``;
    const between = (col: string) =>
      db`${q.from ? db`AND ${db(col)} >= ${q.from}` : db``} ${q.to ? db`AND ${db(col)} <= ${q.to}` : db``}`;
    const status = (col: string) => (q.status ? db`AND ${db(col)} = ${q.status}` : db``);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const text = (...cols: string[]) =>
      like
        ? db`AND (${cols
            .slice(1)
            .reduce(
              (acc, c) => db`${acc} OR ${db(c)} ILIKE ${like}`,
              db`${db(cols[0]!)} ILIKE ${like}`,
            )})`
        : db``;
    const proj = db`json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project`;
    let rows: readonly unknown[];
    switch (kind) {
      case 'daily-reports':
        rows = await db`
          SELECT r.id, to_char(r.report_date, 'YYYY-MM-DD') AS date, r.status, s.name AS site, ${proj},
            u.display_name AS "submittedBy", r.acknowledged_at IS NOT NULL AS acknowledged
          FROM proj.daily_report r JOIN proj.project p ON p.id = r.project_id JOIN proj.site s ON s.id = r.site_id
          LEFT JOIN platform."user" u ON u.id = r.submitted_by
          WHERE ${seen} ${project} ${status('r.status')} ${between('r.report_date')} ${text('s.name', 'p.name')}
          ORDER BY r.report_date DESC, p.name LIMIT ${LIMIT}`;
        break;
      case 'client-bills':
        rows = await db`
          SELECT b.id, b.ra_no AS "raNo", to_char(b.upto, 'YYYY-MM-DD') AS upto, b.status, b.invoice_no AS "invoiceNo",
            to_char(b.certified_on, 'YYYY-MM-DD') AS "certifiedOn", c.name AS client, ${proj},
            coalesce(b.certified->>'net', b.submitted->>'net') AS net
          FROM acc.client_bill b JOIN proj.project p ON p.id = b.project_id
          LEFT JOIN platform.party c ON c.id = p.client_id
          WHERE ${seen} ${project} ${status('b.status')} ${between('b.upto')} ${text('p.name', 'b.invoice_no', 'c.name')}
          ORDER BY b.upto DESC, p.name, b.ra_no DESC LIMIT ${LIMIT}`;
        break;
      case 'subcontract-bills':
        rows = await db`
          SELECT b.id, b.ra_no AS "raNo", to_char(b.upto, 'YYYY-MM-DD') AS upto, b.status, o.number AS "order",
            v.name AS subcontractor, ${proj}, b.figures->>'net' AS net
          FROM acc.subcontract_bill b JOIN proc.purchase_order o ON o.id = b.order_id
          JOIN proj.project p ON p.id = o.project_id JOIN platform.party v ON v.id = o.party_id
          WHERE ${seen} ${project} ${status('b.status')} ${between('b.upto')} ${text('p.name', 'v.name', 'o.number')}
          ORDER BY b.upto DESC, p.name LIMIT ${LIMIT}`;
        break;
      case 'drawings':
        rows = await db`
          SELECT d.id, d.number, d.title, d.discipline, ${proj}, lr.revision, to_char(lr.received_on, 'YYYY-MM-DD')
            AS "receivedOn", lr.purpose, (SELECT count(*)::int FROM proj.drawing_revision x WHERE x.drawing_id = d.id)
            AS revisions
          FROM proj.drawing d JOIN proj.project p ON p.id = d.project_id
          LEFT JOIN LATERAL (SELECT revision, received_on, purpose FROM proj.drawing_revision
            WHERE drawing_id = d.id ORDER BY created_at DESC LIMIT 1) lr ON TRUE
          WHERE ${seen} ${project} ${status('d.discipline')} ${between('lr.received_on')} ${text('d.number', 'd.title', 'p.name')}
          ORDER BY p.name, d.number LIMIT ${LIMIT}`;
        break;
      case 'rfis':
        rows = await db`
          SELECT r.id, r.number, r.subject, r.status, to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn",
            to_char(r.raised_at, 'YYYY-MM-DD') AS raised, u.display_name AS "assignedTo", ${proj},
            r.status = 'open' AND r.due_on < (now() AT TIME ZONE 'Asia/Kolkata')::date AS overdue
          FROM dms.rfi r JOIN proj.project p ON p.id = r.project_id LEFT JOIN platform."user" u ON u.id = r.assigned_to
          WHERE ${seen} ${project} ${status('r.status')} ${between('r.due_on')} ${text('r.number', 'r.subject', 'p.name')}
          ORDER BY r.raised_at DESC LIMIT ${LIMIT}`;
        break;
      case 'inspections':
        rows = await db`
          SELECT i.id, i.number, i.activity, i.location, i.status, to_char(i.requested_for, 'YYYY-MM-DD') AS
            "requestedFor", to_char(i.decided_on, 'YYYY-MM-DD') AS "decidedOn", i.inspector, ${proj}
          FROM qa.inspection i JOIN proj.project p ON p.id = i.project_id
          WHERE ${seen} ${project} ${status('i.status')} ${between('i.requested_for')} ${text('i.number', 'i.activity', 'p.name')}
          ORDER BY i.requested_for DESC LIMIT ${LIMIT}`;
        break;
      case 'ncrs':
        rows = await db`
          SELECT n.id, n.number, n.description, n.source, n.status, n.responsible,
            to_char(n.due_on, 'YYYY-MM-DD') AS "dueOn", to_char(n.closed_on, 'YYYY-MM-DD') AS "closedOn",
            to_char(n.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS raised, ${proj}
          FROM qa.ncr n JOIN proj.project p ON p.id = n.project_id
          WHERE ${seen} ${project} ${status('n.status')} ${between('n.due_on')} ${text('n.number', 'n.description', 'p.name')}
          ORDER BY n.created_at DESC LIMIT ${LIMIT}`;
        break;
      case 'stock-issues':
        rows = await db`
          SELECT i.id, i.number, to_char(i.issued_on, 'YYYY-MM-DD') AS "issuedOn", i.issued_to AS "issuedTo",
            i.purpose, s.id AS "storeId", s.name AS store, w.code AS wbs, ${proj},
            (SELECT coalesce(sum(l.value), 0)::text FROM proc.stock_issue_line l WHERE l.issue_id = i.id) AS value
          FROM proc.stock_issue i JOIN proj.project p ON p.id = i.project_id JOIN proc.store s ON s.id = i.store_id
          LEFT JOIN proj.wbs w ON w.id = i.wbs_id
          WHERE ${seen} ${project} ${between('i.issued_on')} ${text('i.number', 'i.issued_to', 's.name', 'p.name')}
          ORDER BY i.issued_on DESC, i.number DESC LIMIT ${LIMIT}`;
        break;
      case 'stock-transfers':
        rows = await db`
          SELECT t.id, t.number, t.status, to_char(t.sent_on, 'YYYY-MM-DD') AS "sentOn",
            to_char(t.received_on, 'YYYY-MM-DD') AS "receivedOn", fs.name AS "from", ts.name AS "to", ${proj}
          FROM proc.stock_transfer t JOIN proc.store fs ON fs.id = t.from_store_id
          JOIN proc.store ts ON ts.id = t.to_store_id JOIN proj.project p ON p.id = fs.project_id
          WHERE ${seen} ${project} ${status('t.status')} ${between('t.sent_on')} ${text('t.number', 'fs.name', 'ts.name')}
          ORDER BY t.sent_on DESC LIMIT ${LIMIT}`;
        break;
    }
    return { kind, rows, limited: rows.length === LIMIT };
  }
}
