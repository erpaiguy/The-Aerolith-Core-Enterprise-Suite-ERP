// Search everything (docs/wave7-plan.md step 7a.6): one box over document numbers, parties, projects, tenders and
// employees, each kind kept to what the person may see. A handful of hits per kind; the screen opens the record.
import { Injectable } from '@nestjs/common';
import type { PendingQuery, Row, Sql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export interface SearchHit {
  kind: string;
  id: string;
  label: string;
  detail: string | null;
  projectId: string | null;
}

const PER_KIND = 6;

@Injectable()
export class SearchService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  async search(claims: TenantClaims, q: string): Promise<{ hits: SearchHit[] }> {
    const db = await this.tenants.forTenant(claims.ten);
    const [all, hr, books] = await Promise.all([
      this.permissions.can(claims, 'projects.all'),
      this.permissions.can(claims, 'hr.view'),
      this.permissions.can(claims, 'accounts.view'),
    ]);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const seen = (col: string) =>
      all
        ? db`TRUE`
        : db`${db(col)} IN (SELECT project_id FROM proj.member WHERE user_id = ${claims.sub})`;
    const run = (kind: string, rows: Promise<Omit<SearchHit, 'kind'>[]>) =>
      rows.then((r) => r.map((h) => ({ kind, ...h })));
    const none = Promise.resolve([] as SearchHit[]);
    const found = await Promise.all([
      run(
        'project',
        db`SELECT p.id, p.number || ' ' || p.name AS label, p.location AS detail, p.id AS "projectId"
          FROM proj.project p WHERE ${seen('p.id')} AND (p.number ILIKE ${like} OR p.name ILIKE ${like})
          ORDER BY p.number DESC LIMIT ${PER_KIND}`,
      ),
      run(
        'tender',
        db`SELECT t.id, t.number || ' ' || t.title AS label, t.status AS detail, NULL::uuid AS "projectId"
          FROM tender.tender t WHERE t.number ILIKE ${like} OR t.title ILIKE ${like}
          ORDER BY t.number DESC LIMIT ${PER_KIND}`,
      ),
      run(
        'party',
        db`SELECT y.id, y.name AS label, NULL AS detail, NULL::uuid AS "projectId"
          FROM platform.party y WHERE y.deleted_at IS NULL AND y.name ILIKE ${like}
          ORDER BY y.name LIMIT ${PER_KIND}`,
      ),
      hr
        ? run(
            'employee',
            db`SELECT e.id, e.code || ' ' || e.name AS label, e.kind AS detail, NULL::uuid AS "projectId"
              FROM hr.employee e WHERE e.code ILIKE ${like} OR e.name ILIKE ${like}
              ORDER BY e.name LIMIT ${PER_KIND}`,
          )
        : none,
      this.numbered(db, 'requisition', 'proc.requisition', 'title', seen('x.project_id'), like),
      this.numbered(db, 'order', 'proc.purchase_order', null, seen('x.project_id'), like),
      this.numbered(db, 'receipt', 'proc.goods_receipt', null, seen('x.project_id'), like),
      this.numbered(db, 'issue', 'proc.stock_issue', 'issued_to', seen('x.project_id'), like),
      this.numbered(db, 'rfi', 'dms.rfi', 'subject', seen('x.project_id'), like),
      this.numbered(db, 'ncr', 'qa.ncr', 'description', seen('x.project_id'), like),
      run(
        'rfq',
        db`SELECT x.id, x.number || ' ' || x.title AS label, NULL AS detail, x.project_id AS "projectId"
          FROM tender.rfq x WHERE (x.project_id IS NULL OR ${seen('x.project_id')})
            AND (x.number ILIKE ${like} OR x.title ILIKE ${like})
          ORDER BY x.number DESC LIMIT ${PER_KIND}`,
      ),
      books
        ? run(
            'voucher',
            db`SELECT x.id, x.number AS label, x.narration AS detail, NULL::uuid AS "projectId"
              FROM acc.voucher x WHERE x.number ILIKE ${like}
              ORDER BY x.number DESC LIMIT ${PER_KIND}`,
          )
        : none,
      books
        ? run(
            'vendor-bill',
            db`SELECT x.id, x.bill_no AS label, y.name AS detail, x.project_id AS "projectId"
              FROM acc.vendor_bill x JOIN platform.party y ON y.id = x.party_id
              WHERE x.bill_no ILIKE ${like} OR y.name ILIKE ${like}
              ORDER BY x.created_at DESC LIMIT ${PER_KIND}`,
          )
        : none,
    ]);
    return { hits: found.flat() };
  }

  /** A project's numbered record (requisition, order, receipt, issue, RFI, NCR): by number, or by its text. */
  private numbered(
    db: Sql,
    kind: string,
    table: string,
    text: string | null,
    seen: PendingQuery<Row[]>,
    like: string,
  ): Promise<SearchHit[]> {
    const label = text ? db`x.number || ' ' || x.${db(text)}` : db`x.number`;
    const match = text
      ? db`x.number ILIKE ${like} OR x.${db(text)} ILIKE ${like}`
      : db`x.number ILIKE ${like}`;
    return db<Omit<SearchHit, 'kind'>[]>`
      SELECT x.id, ${label} AS label, p.name AS detail, x.project_id AS "projectId"
      FROM ${db(table)} x JOIN proj.project p ON p.id = x.project_id
      WHERE ${seen} AND (${match})
      ORDER BY x.number DESC LIMIT ${PER_KIND}`.then((r) => r.map((h) => ({ kind, ...h })));
  }
}
