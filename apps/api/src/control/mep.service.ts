// The MEP pack (docs/wave4-plan.md step 7): system-wise BOQ templates and testing and commissioning checklists loaded
// once for the company; per project, an equipment schedule (commissioned only on a passed checklist) and a
// coordination and clash log.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
export const SYSTEMS = ['hvac', 'electrical', 'plumbing', 'fire', 'elv'] as const;
export type MepSystem = (typeof SYSTEMS)[number];
const STATUSES = [
  'planned',
  'ordered',
  'delivered',
  'installed',
  'tested',
  'commissioned',
] as const;

/** [section, [code, description, unit][]][] for each system. Units, no quantities or rates. */
const BOQ: Record<MepSystem, { name: string; sections: [string, [string, string, string][]][] }> = {
  hvac: {
    name: 'MEP: HVAC',
    sections: [
      [
        'Equipment',
        [
          ['H.1', 'Air-cooled chiller, supply, installation and testing', 'TR'],
          ['H.2', 'Air handling unit with filters and VFD', 'no'],
          ['H.3', 'Fan coil unit, ceiling concealed', 'no'],
          ['H.4', 'Ventilation fan, inline', 'no'],
        ],
      ],
      [
        'Distribution',
        [
          ['H.5', 'GI ducting with supports', 'sqm'],
          ['H.6', 'Duct insulation, nitrile rubber', 'sqm'],
          ['H.7', 'Chilled water piping, MS with insulation', 'm'],
          ['H.8', 'Supply and return air grilles and diffusers', 'no'],
        ],
      ],
      ['Controls', [['H.9', 'Building management points for HVAC', 'point']]],
    ],
  },
  electrical: {
    name: 'MEP: Electrical',
    sections: [
      [
        'HT and LT panels',
        [
          ['E.1', 'HT panel, VCB', 'no'],
          ['E.2', 'Main LT panel', 'no'],
          ['E.3', 'Distribution board, 8-way TPN', 'no'],
        ],
      ],
      [
        'Cabling',
        [
          ['E.4', 'LT armoured cable, 3.5 core, laid in trench', 'm'],
          ['E.5', 'Cable tray, ladder type', 'm'],
        ],
      ],
      [
        'Wiring and fittings',
        [
          ['E.6', 'Point wiring, lights and fans', 'point'],
          ['E.7', 'Power point, 6/16 A', 'point'],
          ['E.8', 'LED light fitting', 'no'],
        ],
      ],
      [
        'Earthing and protection',
        [
          ['E.9', 'Earth pit, copper plate', 'no'],
          ['E.10', 'Lightning arrester with down conductor', 'set'],
        ],
      ],
    ],
  },
  plumbing: {
    name: 'MEP: Plumbing',
    sections: [
      [
        'Water supply',
        [
          ['P.1', 'CPVC piping with fittings', 'm'],
          ['P.2', 'Overhead tank, HDPE', 'litre'],
          ['P.3', 'Transfer pump set', 'no'],
        ],
      ],
      [
        'Drainage',
        [
          ['P.4', 'UPVC soil and waste piping', 'm'],
          ['P.5', 'Inspection chamber', 'no'],
        ],
      ],
      [
        'Sanitary fixtures',
        [
          ['P.6', 'Water closet with flushing cistern', 'no'],
          ['P.7', 'Wash basin with fittings', 'no'],
        ],
      ],
    ],
  },
  fire: {
    name: 'MEP: Fire fighting',
    sections: [
      [
        'Pumps',
        [
          ['F.1', 'Main electric fire pump', 'no'],
          ['F.2', 'Jockey pump', 'no'],
          ['F.3', 'Diesel engine driven fire pump', 'no'],
        ],
      ],
      [
        'Distribution',
        [
          ['F.4', 'MS C-class piping, painted', 'm'],
          ['F.5', 'Sprinkler head, pendant', 'no'],
          ['F.6', 'Landing valve with hose reel', 'set'],
        ],
      ],
      [
        'Detection',
        [
          ['F.7', 'Smoke detector, addressable', 'no'],
          ['F.8', 'Fire alarm panel', 'no'],
          ['F.9', 'Portable extinguisher, ABC', 'no'],
        ],
      ],
    ],
  },
  elv: {
    name: 'MEP: ELV',
    sections: [
      [
        'Security',
        [
          ['L.1', 'CCTV camera, IP', 'no'],
          ['L.2', 'Network video recorder', 'no'],
          ['L.3', 'Access control reader', 'no'],
        ],
      ],
      [
        'Networks',
        [
          ['L.4', 'Structured cabling point, Cat 6', 'point'],
          ['L.5', 'Network rack with switches', 'no'],
          ['L.6', 'Public address speaker', 'no'],
        ],
      ],
    ],
  },
};

/** Testing and commissioning, per system: [text, kind, min?, max?]. Every item is required. */
const TNC: Record<
  MepSystem,
  { name: string; items: [string, 'yes_no' | 'number', number?, number?][] }
> = {
  hvac: {
    name: 'T&C: HVAC',
    items: [
      ['Ducts pressure-tested and sealed', 'yes_no'],
      ['Air balancing done to design volumes', 'yes_no'],
      ['Supply air temperature (°C)', 'number', 12, 16],
      ['Chiller running amps within the nameplate', 'yes_no'],
      ['Controls and interlocks checked', 'yes_no'],
    ],
  },
  electrical: {
    name: 'T&C: Electrical',
    items: [
      ['Insulation resistance (MΩ)', 'number', 1],
      ['Earth resistance (Ω)', 'number', 0, 2],
      ['Breakers and relays tested to settings', 'yes_no'],
      ['Phase sequence and polarity checked', 'yes_no'],
      ['Panels labelled, single-line diagram displayed', 'yes_no'],
    ],
  },
  plumbing: {
    name: 'T&C: Plumbing',
    items: [
      ['Pressure test held (kg/cm²)', 'number', 10],
      ['No leaks after 24 hours', 'yes_no'],
      ['Drainage flow test passed', 'yes_no'],
      ['Pumps rotate correctly, no vibration', 'yes_no'],
    ],
  },
  fire: {
    name: 'T&C: Fire fighting',
    items: [
      ['Hydrostatic test held (kg/cm²)', 'number', 14],
      ['Pumps start on pressure drop', 'yes_no'],
      ['Sprinkler flow switch raises the alarm', 'yes_no'],
      ['Detectors and the panel tested zone by zone', 'yes_no'],
    ],
  },
  elv: {
    name: 'T&C: ELV',
    items: [
      ['Cabling tested and certified', 'yes_no'],
      ['Cameras recording at the set resolution', 'yes_no'],
      ['Access control fails safe on fire alarm', 'yes_no'],
    ],
  },
};

@Injectable()
export class MepService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
  ) {}

  private async team(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team keeps its MEP records.",
      });
  }

  /** The pack, once: anything already there by name is left as it is. */
  async loadPack(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'boq.edit')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'boq.edit',
        message: 'Loading the MEP pack needs the BOQ permission.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const added = { boqTemplates: [] as string[], checklists: [] as string[] };
      for (const sys of SYSTEMS) {
        const b = BOQ[sys];
        const [have] =
          await tx`SELECT 1 FROM est.boq_template WHERE lower(name) = lower(${b.name}) AND archived_at IS NULL`;
        if (!have) {
          const lines: {
            depth: number;
            type: 'section' | 'item';
            code: string | null;
            description: string;
            unit: string | null;
          }[] = [];
          b.sections.forEach(([section, items], i) => {
            lines.push({
              depth: 0,
              type: 'section',
              code: String(i + 1),
              description: section,
              unit: null,
            });
            for (const [code, description, unit] of items)
              lines.push({ depth: 1, type: 'item', code, description, unit });
          });
          const [t] = await tx<{ id: string }[]>`
            INSERT INTO est.boq_template (name, vertical, description, with_quantities, with_rates, line_count, item_count,
              created_by, updated_by)
            VALUES (${b.name}, 'mep', ${'System-wise items for MEP works (the MEP pack): units only, no quantities or rates.'},
              false, false, ${lines.length}, ${lines.filter((l) => l.type === 'item').length}, ${claims.sub}, ${claims.sub})
            RETURNING id`;
          for (const [seq, l] of lines.entries())
            await tx`INSERT INTO est.boq_template_line (template_id, seq, depth, node_type, code, description, unit)
              VALUES (${t!.id}, ${seq + 1}, ${l.depth}, ${l.type}, ${l.code}, ${l.description}, ${l.unit})`;
          added.boqTemplates.push(b.name);
        }
        const c = TNC[sys];
        const [had] =
          await tx`SELECT 1 FROM qa.checklist_template WHERE lower(name) = lower(${c.name})`;
        if (!had) {
          const items = c.items.map(([text, kind, min, max]) => ({
            text,
            kind,
            required: true,
            ...(min !== undefined ? { min } : {}),
            ...(max !== undefined ? { max } : {}),
          }));
          await tx`INSERT INTO qa.checklist_template (name, work_type, items, created_by)
            VALUES (${c.name}, 'MEP testing', ${tx.json(items)}, ${claims.sub})`;
          added.checklists.push(c.name);
        }
      }
      await audit(tx, claims.sub, 'mep.pack', 'boq_template', claims.sub, added);
      return added;
    });
  }

  async register(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const equipment = await db`
      SELECT e.id, e.tag, e.system, e.description, e.capacity, e.location, e.make, e.status, e.checklist_id AS "checklistId",
        c.result AS "checklistResult", e.row_version AS "rowVersion"
      FROM ctl.mep_equipment e LEFT JOIN qa.checklist c ON c.id = e.checklist_id
      WHERE e.project_id = ${projectId} ORDER BY e.system, e.tag`;
    const issues = await db`
      SELECT id, number, systems, location, drawing_ref AS "drawingRef", description, to_char(raised_on, 'YYYY-MM-DD') AS "raisedOn",
        status, resolution, to_char(resolved_on, 'YYYY-MM-DD') AS "resolvedOn"
      FROM ctl.coordination_issue WHERE project_id = ${projectId} ORDER BY number`;
    const checklists = await db`
      SELECT c.id, t.name AS template, to_char(c.done_on, 'YYYY-MM-DD') AS "doneOn", c.location, c.result
      FROM qa.checklist c JOIN qa.checklist_template t ON t.id = c.template_id
      WHERE c.project_id = ${projectId} AND t.work_type = 'MEP testing' ORDER BY c.done_on DESC`;
    const byStatus = Object.fromEntries(
      STATUSES.map((s) => [s, equipment.filter((e) => e.status === s).length]),
    );
    return { equipment, byStatus, issues, checklists, systems: SYSTEMS };
  }

  async addEquipment(
    claims: TenantClaims,
    projectId: string,
    input: {
      tag: string;
      system: MepSystem;
      description: string;
      capacity: string;
      location: string;
      make: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    try {
      await db`INSERT INTO ctl.mep_equipment (project_id, tag, system, description, capacity, location, make)
        VALUES (${projectId}, ${input.tag}, ${input.system}, ${input.description}, ${input.capacity}, ${input.location}, ${input.make})`;
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new ConflictException({
          code: 'tag_taken',
          message: `${input.tag} is already on the schedule.`,
        });
      throw err;
    }
    return this.register(claims, projectId);
  }

  /** Moves an item along; commissioned needs a passed testing and commissioning checklist of this project. */
  async setStatus(
    claims: TenantClaims,
    id: string,
    input: { status: (typeof STATUSES)[number]; checklistId: string | null; rowVersion: number },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db<
      { project_id: string }[]
    >`SELECT project_id FROM ctl.mep_equipment WHERE id = ${id}`;
    if (!e) throw new NotFoundException({ code: 'not_found', message: 'No such equipment.' });
    await this.team(db, claims, e.project_id);
    if (input.status === 'commissioned') {
      if (!input.checklistId)
        throw new BadRequestException({
          code: 'checklist_needed',
          message: 'Commissioning needs its testing and commissioning checklist.',
        });
      const [c] = await db<{ result: string }[]>`
        SELECT c.result FROM qa.checklist c JOIN qa.checklist_template t ON t.id = c.template_id
        WHERE c.id = ${input.checklistId} AND c.project_id = ${e.project_id} AND t.work_type = 'MEP testing'`;
      if (!c)
        throw new BadRequestException({
          code: 'not_a_tnc',
          message: 'Not a testing and commissioning checklist of this project.',
        });
      if (c.result !== 'passed')
        throw new ConflictException({
          code: 'checklist_failed',
          message: 'The checklist failed: commission it once a passed one is recorded.',
        });
    }
    const r = await db`
      UPDATE ctl.mep_equipment SET status = ${input.status}, checklist_id = coalesce(${input.checklistId}, checklist_id),
        updated_at = now(), row_version = row_version + 1
      WHERE id = ${id} AND row_version = ${input.rowVersion} RETURNING 1`;
    if (!r.length)
      throw new ConflictException({
        code: 'stale',
        message: 'Someone else changed it; reload and try again.',
      });
    return this.register(claims, e.project_id);
  }

  async raiseIssue(
    claims: TenantClaims,
    projectId: string,
    input: {
      systems: MepSystem[];
      location: string;
      drawingRef: string;
      description: string;
      raisedOn: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.team(db, claims, projectId);
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      const [n] = await tx<
        { n: number }[]
      >`SELECT count(*)::int + 1 AS n FROM ctl.coordination_issue WHERE project_id = ${projectId}`;
      await tx`INSERT INTO ctl.coordination_issue (project_id, number, systems, location, drawing_ref, description, raised_on)
        VALUES (${projectId}, ${`CI-${String(n!.n).padStart(3, '0')}`}, ${input.systems}, ${input.location}, ${input.drawingRef},
          ${input.description}, ${input.raisedOn})`;
    });
    return this.register(claims, projectId);
  }

  async resolveIssue(claims: TenantClaims, id: string, input: { resolution: string; on: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    const [i] = await db<
      { project_id: string; status: string }[]
    >`SELECT project_id, status FROM ctl.coordination_issue WHERE id = ${id}`;
    if (!i) throw new NotFoundException({ code: 'not_found', message: 'No such issue.' });
    await this.team(db, claims, i.project_id);
    if (i.status === 'resolved')
      throw new ConflictException({ code: 'resolved', message: 'Already resolved.' });
    await db`UPDATE ctl.coordination_issue SET status = 'resolved', resolution = ${input.resolution}, resolved_on = ${input.on}
      WHERE id = ${id}`;
    return this.register(claims, i.project_id);
  }
}
