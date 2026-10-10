// The rules of a project's life (docs/wave2a-plan.md step 1): which status follows which, and when a reason is asked.
export const PROJECT_STATUSES = [
  'planned',
  'active',
  'on_hold',
  'completed',
  'closed',
  'cancelled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectRole = 'lead' | 'member' | 'viewer';

const MOVES: Record<ProjectStatus, ProjectStatus[]> = {
  planned: ['active', 'on_hold', 'cancelled'],
  active: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['active', 'cancelled'],
  // Completed: the work is done; closed: the accounts and retention are settled too. Reopened if snags come back.
  completed: ['active', 'closed'],
  closed: ['completed'],
  cancelled: ['planned'],
};

export const allowedProjectMoves = (from: ProjectStatus): ProjectStatus[] => MOVES[from];

/** Putting a project on hold or cancelling it needs a reason, for whoever looks later. */
export const PROJECT_REASON_REQUIRED: ProjectStatus[] = ['on_hold', 'cancelled'];

/** Statuses where work goes on (the register shows these first). */
export const LIVE_STATUSES: ProjectStatus[] = ['planned', 'active', 'on_hold'];
