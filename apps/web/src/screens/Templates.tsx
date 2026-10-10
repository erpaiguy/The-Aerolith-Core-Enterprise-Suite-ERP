// BOQ templates (docs/wave1-plan.md step 13): the company's standard BOQs per vertical. Saved from a BOQ, chosen when
// a tender gets a new BOQ, renamed or archived here.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { BoqTemplate } from '../api/types';
import { describeError, formatDate } from '../lib/format';
import { usePermission } from '../session/permissions';
import { VERTICALS } from './TenderForm';

export function SaveTemplateDialog({
  boqId,
  boqName,
  onClose,
}: {
  boqId: string;
  boqName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(boqName);
  const [vertical, setVertical] = useState('buildings');
  const [description, setDescription] = useState('');
  const [withQuantities, setWithQuantities] = useState(false);
  const [withRates, setWithRates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<BoqTemplate | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setSaved(
        await api.request<BoqTemplate>(`/api/tenant/boqs/${boqId}/save-as-template`, {
          method: 'POST',
          body: { name, vertical, description, withQuantities, withRates },
        }),
      );
      void qc.invalidateQueries({ queryKey: ['boq-templates'] });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-24"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Save as template"
        className="w-full max-w-lg space-y-4 rounded-lg border border-line bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <h2 className="font-semibold">Save as template</h2>
          <Button variant="ghost" aria-label="Close" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        {saved ? (
          <>
            <Alert tone="success">
              Saved &ldquo;{saved.name}&rdquo;: {saved.lineCount} lines. Choose it under
              &ldquo;Start from&rdquo; when you add a BOQ to a tender.
            </Alert>
            <div className="flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              The BOQ&rsquo;s sections, items, units and kinds become a template for new BOQs. It is
              a copy: later changes to this BOQ do not change it.
            </p>
            <Field label="Template name">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label="Vertical">
              <Select value={vertical} onChange={(e) => setVertical(e.target.value)}>
                {Object.entries(VERTICALS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description (optional)">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={withQuantities}
                onChange={(e) => setWithQuantities(e.target.checked)}
              />
              Keep the quantities
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={withRates}
                onChange={(e) => setWithRates(e.target.checked)}
              />
              Keep the rates (and their rate analyses)
            </label>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button busy={busy} disabled={!name.trim()} onClick={() => void save()}>
                Save template
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The templates, to rename and archive. */
export function TemplatesScreen() {
  const qc = useQueryClient();
  const canEdit = usePermission('boq.edit');
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['boq-templates', archived],
    queryFn: () =>
      api.request<BoqTemplate[]>(
        `/api/tenant/boq-templates?archived=${archived ? 'true' : 'false'}`,
      ),
  });
  const act = async (t: BoqTemplate, body: object, path = '') => {
    setError(null);
    try {
      await api.request(`/api/tenant/boq-templates/${t.id}${path}`, { method: 'POST', body });
      void qc.invalidateQueries({ queryKey: ['boq-templates'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="BOQ templates"
        subtitle="Save a BOQ as a template from its page; start a tender's BOQ from one."
      />
      <div className="flex gap-1" role="tablist">
        {[false, true].map((a) => (
          <button
            key={String(a)}
            role="tab"
            aria-selected={archived === a}
            onClick={() => setArchived(a)}
            className={`rounded-md px-3 py-1.5 text-sm ${archived === a ? 'bg-surface-2 font-medium' : 'text-fg-muted hover:bg-surface-2'}`}
          >
            {a ? 'Archived' : 'In use'}
          </button>
        ))}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="danger">{describeError(list.error)}</Alert>
        ) : list.data.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {archived
              ? 'No archived template.'
              : 'No template yet. Open a BOQ and use "Save as template".'}
          </p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Templates">
            {list.data.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-fg-muted">
                    {t.lineCount.toLocaleString('en-IN')} lines,{' '}
                    {t.itemCount.toLocaleString('en-IN')} items · saved {formatDate(t.updatedAt)}
                    {t.createdBy ? ` by ${t.createdBy}` : ''}
                    {t.description ? ` · ${t.description}` : ''}
                  </div>
                </div>
                <Badge>{VERTICALS[t.vertical] ?? t.vertical}</Badge>
                {t.withQuantities && <Badge tone="accent">quantities</Badge>}
                {t.withRates && <Badge tone="accent">rates</Badge>}
                {canEdit && (
                  <>
                    <Select
                      aria-label={`Vertical of ${t.name}`}
                      className="w-32"
                      value={t.vertical}
                      onChange={(e) =>
                        void act(t, { rowVersion: t.rowVersion, vertical: e.target.value })
                      }
                    >
                      {Object.entries(VERTICALS).map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="ghost"
                      onClick={() => void act(t, { archived: !archived }, '/archive')}
                    >
                      {archived ? (
                        <>
                          <ArchiveRestore className="size-4" aria-hidden /> Restore
                        </>
                      ) : (
                        <>
                          <Archive className="size-4" aria-hidden /> Archive
                        </>
                      )}
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
