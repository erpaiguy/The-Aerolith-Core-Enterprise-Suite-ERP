// Documents linked to something on a tender (docs/wave1-plan.md step 13): an addendum's corrigendum, the certificate a
// checklist item asks for. The file is kept in the tender's documents (in the standard folder for it when the tender
// has one the user may see) and linked here; unlinking leaves it in the documents.
import { Button } from '@aerolith/ui';
import { FileText, Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, saveFile } from '../api/client';
import type { DocVault } from '../api/types';
import { describeError } from '../lib/format';

export interface LinkedDocument {
  id: string;
  name: string;
}

export function LinkedDocuments({
  tenderId,
  kind,
  targetId,
  label,
  documents,
  folder,
  canAttach,
  onChanged,
}: {
  tenderId: string;
  kind: 'addendum' | 'checklist_item';
  targetId: string;
  /** What the documents belong to, for screen readers: "Corrigendum 1". */
  label: string;
  documents: LinkedDocument[];
  /** The standard folder to keep new files in, when the tender has it. */
  folder: string | null;
  canAttach: boolean;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const link = (documentId: string, remove = false) =>
    api.request(`/api/tenant/documents/${documentId}/links${remove ? '/delete' : ''}`, {
      method: 'POST',
      body: { kind, targetId },
    });
  const attach = (files: File[]) =>
    void run(async () => {
      const vault = await api.request<DocVault>(`/api/tenant/tenders/${tenderId}/documents`);
      const f = folder ? vault.folders.find((x) => x.name === folder) : undefined;
      for (const file of files) {
        const { document } = await api.upload<{ document: { id: string } }>(
          `/api/tenant/tenders/${tenderId}/documents/upload${f ? `?folderId=${f.id}` : ''}`,
          file,
        );
        await link(document.id);
      }
    });
  const open = (id: string) =>
    void (async () => {
      try {
        const { blob, fileName } = await api.download(`/api/tenant/documents/${id}/file`);
        saveFile(blob, fileName);
      } catch (err) {
        setError(describeError(err));
      }
    })();

  if (documents.length === 0 && !canAttach) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {documents.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Documents of ${label}`}>
          {documents.map((d) => (
            <li
              key={d.id}
              className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5"
            >
              <FileText className="size-3.5 text-fg-muted" aria-hidden />
              <button type="button" className="hover:underline" onClick={() => open(d.id)}>
                {d.name}
              </button>
              {canAttach && (
                <button
                  type="button"
                  className="rounded text-fg-muted hover:text-danger"
                  aria-label={`Unlink ${d.name}`}
                  onClick={() => void run(() => link(d.id, true))}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAttach && (
        <>
          <input
            ref={input}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-label={`Files for ${label}`}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) attach(files);
            }}
          />
          <Button
            variant="ghost"
            busy={busy}
            aria-label={`Attach documents to ${label}`}
            onClick={() => input.current?.click()}
          >
            <Paperclip className="size-3.5" aria-hidden /> Attach
          </Button>
        </>
      )}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
