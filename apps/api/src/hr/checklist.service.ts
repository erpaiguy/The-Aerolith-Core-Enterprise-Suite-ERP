// Joining and exit checklists (docs/wave7-plan.md step 7d.8): the steps when someone joins or leaves. Steps the
// records answer are worked out from them, never ticked: PAN, bank account and UAN on the record, a sign-in made and a
// deployment entered when joining; the sign-in closed and the full and final settlement posted when leaving. HR ticks
// the rest with a note. A checklist is complete when every step is done.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { HrService } from './hr.service.js';

type Kind = 'joining' | 'exit';
/** A step's key, its label, and whether the records answer it (then it cannot be ticked). */
export const STEPS: Record<Kind, { key: string; label: string; auto?: true }[]> = {
  joining: [
    { key: 'appointment_letter', label: 'Appointment letter issued and signed' },
    { key: 'documents', label: 'Documents collected (ID, address, education, photographs)' },
    { key: 'pan', label: 'PAN on the record', auto: true },
    { key: 'bank', label: 'Bank account on the record', auto: true },
    { key: 'uan', label: 'PF UAN on the record', auto: true },
    { key: 'sign_in', label: 'Sign-in made', auto: true },
    { key: 'deployed', label: 'Deployed to a project or the head office', auto: true },
    { key: 'induction', label: 'Induction and safety briefing' },
    { key: 'id_card_ppe', label: 'ID card and PPE issued' },
  ],
  exit: [
    { key: 'resignation', label: 'Resignation accepted, last day set' },
    { key: 'handover', label: 'Work and documents handed over' },
    { key: 'assets', label: 'Company assets back (laptop, phone, PPE, ID card)' },
    { key: 'sign_in_closed', label: 'Sign-in closed', auto: true },
    { key: 'settlement', label: 'Full and final settlement posted', auto: true },
    { key: 'relieving_letter', label: 'Relieving and experience letters issued' },
    { key: 'exit_interview', label: 'Exit interview' },
  ],
};

@Injectable()
export class PeopleChecklistService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly hr: HrService,
  ) {}

  async get(claims: TenantClaims, employeeId: string) {
    await this.hr.must(claims, 'hr.view');
    const db = await this.tenants.forTenant(claims.ten);
    await this.hr.employee(db, employeeId);
    const [facts] = await db<
      {
        pan: boolean;
        bank: boolean;
        uan: boolean;
        sign_in: boolean;
        deployed: boolean;
        sign_in_closed: boolean;
        settlement: boolean;
        left_on: string | null;
      }[]
    >`
      SELECT e.pan IS NOT NULL AS pan, e.bank_account IS NOT NULL AS bank, e.uan IS NOT NULL AS uan,
        e.user_id IS NOT NULL AS sign_in,
        EXISTS (SELECT 1 FROM hr.deployment d WHERE d.employee_id = e.id) AS deployed,
        (e.user_id IS NULL OR u.status = 'deactivated') AS sign_in_closed,
        EXISTS (SELECT 1 FROM pay.settlement s WHERE s.employee_id = e.id AND s.status IN ('posted', 'paid'))
          AS settlement,
        to_char(e.left_on, 'YYYY-MM-DD') AS left_on
      FROM hr.employee e LEFT JOIN platform."user" u ON u.id = e.user_id WHERE e.id = ${employeeId}`;
    const rows = await db<
      {
        id: string;
        kind: Kind;
        position: number;
        key: string;
        label: string;
        doneOn: string | null;
        doneBy: string | null;
        note: string;
      }[]
    >`
      SELECT s.id, s.kind, s.position, s.key, s.label, to_char(s.done_on, 'YYYY-MM-DD') AS "doneOn",
        u.display_name AS "doneBy", s.note
      FROM hr.checklist_step s LEFT JOIN platform."user" u ON u.id = s.done_by
      WHERE s.employee_id = ${employeeId} ORDER BY s.kind, s.position`;
    const f = facts as unknown as Record<string, boolean>;
    const list = (kind: Kind) => {
      const steps = rows
        .filter((r) => r.kind === kind)
        .map((r) => {
          const auto = STEPS[kind].some((s) => s.key === r.key && s.auto);
          return { ...r, auto, done: auto ? f[r.key] === true : r.doneOn !== null };
        });
      return steps.length
        ? { steps, done: steps.filter((s) => s.done).length, complete: steps.every((s) => s.done) }
        : null;
    };
    return {
      joining: list('joining'),
      exit: list('exit'),
      leftOn: facts!.left_on,
      mayEdit: await this.hr
        .must(claims, 'hr.edit')
        .then(() => true)
        .catch(() => false),
    };
  }

  async start(claims: TenantClaims, employeeId: string, kind: Kind) {
    await this.hr.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await this.hr.employee(db, employeeId);
    const [had] =
      await db`SELECT 1 FROM hr.checklist_step WHERE employee_id = ${employeeId} AND kind = ${kind}`;
    if (had)
      throw new ConflictException({
        code: 'started',
        message: 'That checklist is already started.',
      });
    await db.begin(async (tx) => {
      for (const [i, s] of STEPS[kind].entries())
        await tx`
          INSERT INTO hr.checklist_step (employee_id, kind, position, key, label)
          VALUES (${employeeId}, ${kind}, ${i + 1}, ${s.key}, ${s.label})`;
    });
    return this.get(claims, employeeId);
  }

  /** A step HR ticks (or unticks), with a note; the records' own steps are not ticked. */
  async tick(
    claims: TenantClaims,
    stepId: string,
    b: { done: boolean; doneOn: string; note: string },
  ) {
    await this.hr.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db<{ employee_id: string; kind: Kind; key: string }[]>`
      SELECT employee_id, kind, key FROM hr.checklist_step WHERE id = ${stepId}`;
    if (!s) throw new NotFoundException({ code: 'not_found' });
    if (STEPS[s.kind].some((x) => x.key === s.key && x.auto))
      throw new BadRequestException({
        code: 'from_the_records',
        message: 'This step follows the records; change the record instead.',
      });
    await db`
      UPDATE hr.checklist_step SET done_on = ${b.done ? b.doneOn : null}, done_by = ${b.done ? claims.sub : null},
        note = ${b.note}
      WHERE id = ${stepId}`;
    return this.get(claims, s.employee_id);
  }
}
