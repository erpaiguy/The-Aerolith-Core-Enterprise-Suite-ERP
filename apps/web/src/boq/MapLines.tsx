// Mapping a project BOQ's lines to a WBS element and a cost code (docs/wave2a-plan.md step 3): the selected lines
// (a section brings its items) or the line in hand, done by the server in one go. Each side can be left as it is,
// set, or cleared.
import { Alert, Button, Dialog, Field, Select } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import type { CostCode, ProjectDetail, WbsNode } from '../api/types';
import type { BoqRow } from './model';
import { describeError } from '../lib/format';

const KEEP = '';
const CLEAR = 'none';
const nbsp = (depth: number) => '  '.repeat(depth);

export interface MappingOptions {
  /** On the project's team as lead or member (or editing projects). */
  canMap: boolean;
  wbs: WbsNode[];
  costCodes: CostCode[];
  /** A contract BOQ: opens an item's measurement book. */
  onMeasure?: ((row: BoqRow) => void) | undefined;
}

/** What the grid needs to show and map a project BOQ's lines; undefined for a tender's BOQ (or until loaded). */
export function useMappingOptions(
  projectId: string | null | undefined,
): MappingOptions | undefined {
  const enabled = Boolean(projectId);
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
    enabled,
  });
  const wbs = useQuery({
    queryKey: ['project-wbs', projectId],
    queryFn: () => api.request<WbsNode[]>(`/api/tenant/projects/${projectId}/wbs`),
    enabled,
  });
  const costCodes = useQuery({
    queryKey: ['cost-codes'],
    queryFn: () => api.request<CostCode[]>('/api/tenant/cost-codes'),
    enabled,
  });
  if (!enabled || !project.data || !wbs.data || !costCodes.data) return undefined;
  return {
    canMap: project.data.canEdit || project.data.myRole === 'member',
    wbs: wbs.data,
    costCodes: costCodes.data,
  };
}

export function MapLinesDialog({
  boqId,
  range,
  options,
  onClose,
  onDone,
}: {
  boqId: string;
  range: { anchor: string; to: string; single: boolean };
  options: MappingOptions;
  onClose: () => void;
  onDone: () => void;
}) {
  const [wbs, setWbs] = useState(KEEP);
  const [cost, setCost] = useState(KEEP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<number | null>(null);
  const pick = (v: string) => (v === KEEP ? undefined : v === CLEAR ? null : v);
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.request<{ changed: number }>(`/api/tenant/boqs/${boqId}/mapping`, {
        method: 'POST',
        body: { from: range.anchor, to: range.to, wbsId: pick(wbs), costCodeId: pick(cost) },
      });
      setChanged(r.changed);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={changed !== null ? onDone : onClose}
      title="Map to WBS and cost code"
      description={`Map ${range.single ? 'this line' : 'the selected lines'}.`}
      footer={
        changed !== null ? (
          <Button onClick={onDone}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              busy={busy}
              disabled={wbs === KEEP && cost === KEEP}
              onClick={() => void apply()}
            >
              Map
            </Button>
          </>
        )
      }
    >
      {changed !== null ? (
        <Alert tone="success">
          {changed.toLocaleString('en-IN')} item{changed === 1 ? '' : 's'} mapped.
        </Alert>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            Items only; a section brings everything under it. The contract BOQ and the budget share
            their lines, so both are mapped.
          </p>
          <Field label="WBS element">
            <Select value={wbs} onChange={(e) => setWbs(e.target.value)}>
              <option value={KEEP}>Leave as it is</option>
              <option value={CLEAR}>None (clear)</option>
              {options.wbs.map((n) => (
                <option key={n.id} value={n.id}>
                  {nbsp(n.depth)}
                  {n.code} · {n.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Cost code">
            <Select value={cost} onChange={(e) => setCost(e.target.value)}>
              <option value={KEEP}>Leave as it is</option>
              <option value={CLEAR}>None (clear)</option>
              {options.costCodes
                .filter((c) => c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {nbsp(c.depth)}
                    {c.code} · {c.name}
                  </option>
                ))}
            </Select>
          </Field>
          {options.wbs.length === 0 && (
            <p className="text-xs text-fg-muted">The project has no WBS yet.</p>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}
