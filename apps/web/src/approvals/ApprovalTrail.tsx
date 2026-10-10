// A request's levels and what happened to it: shown on the approval's page and the document's own.
import { Badge, cx } from '@aerolith/ui';
import { Check, Circle, Clock, X } from 'lucide-react';
import { formatDateTime, formatInr } from '../lib/format';
import { EVENT_TEXT, type Approval } from './model';

export function ApprovalSteps({ approval }: { approval: Approval }) {
  if (!approval.steps.length) return null;
  return (
    <ol className="space-y-2" aria-label="Approval levels">
      {approval.steps.map((s) => (
        <li key={s.level} className="flex items-start gap-2.5 text-sm">
          <span
            className={cx(
              'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
              s.status === 'approved' && 'bg-success text-white',
              s.status === 'rejected' && 'bg-danger text-white',
              s.status === 'pending' && 'bg-warning text-white',
              s.status === 'waiting' && 'bg-surface-3 text-fg-muted',
            )}
            aria-hidden
          >
            {s.status === 'approved' ? (
              <Check className="size-3.5" />
            ) : s.status === 'rejected' ? (
              <X className="size-3.5" />
            ) : s.status === 'pending' ? (
              <Clock className="size-3.5" />
            ) : (
              <Circle className="size-3" />
            )}
          </span>
          <div className="min-w-0" data-testid={`level-${s.level}`}>
            <div>
              <span className="font-medium">
                Level {s.level}
                {s.label ? `: ${s.label}` : ''}
              </span>{' '}
              <span className="text-fg-muted">
                · {s.approverName}
                {Number(s.minAmount) > 0 && `, from ${formatInr(s.minAmount)}`}
              </span>{' '}
              {s.toAdmins && <Badge tone="warning">to the admins</Badge>}
            </div>
            {s.actedBy && (
              <div className="text-xs text-fg-muted">
                {s.status === 'approved' ? 'Approved' : 'Rejected'} by {s.actedBy}
                {s.onBehalfOf && ` for ${s.onBehalfOf}`}
                {s.actedAt && `, ${formatDateTime(s.actedAt)}`}
                {s.comment && <span className="block italic">“{s.comment}”</span>}
              </div>
            )}
            {s.status === 'pending' && <div className="text-xs text-warning">Waiting</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ApprovalEvents({ approval }: { approval: Approval }) {
  return (
    <ul className="space-y-1.5 text-sm" aria-label="Approval history">
      {approval.events.map((e) => (
        <li key={e.id}>
          <span className="text-xs text-fg-muted">{formatDateTime(e.at)}</span>{' '}
          {e.actor && <span className="font-medium">{e.actor}</span>}
          {e.onBehalfOf && <span className="text-fg-muted"> (for {e.onBehalfOf})</span>}{' '}
          {EVENT_TEXT[e.kind]}
          {e.level !== null && e.kind !== 'submitted' && e.kind !== 'commented'
            ? ` level ${e.level}`
            : ''}
          {e.comment && <span className="block pl-4 italic text-fg-muted">“{e.comment}”</span>}
        </li>
      ))}
    </ul>
  );
}
