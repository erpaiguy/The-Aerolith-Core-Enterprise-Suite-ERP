// Documents (docs/wave1-plan.md step 10): a tender's or a project's vault (folders, uploads with versions, preview,
// tags, the trash, ZIP downloads; projects from docs/wave2b-plan.md step 8) and the Documents page that searches them.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Textarea,
  cx,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Download,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Lock,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { api, saveFile } from '../api/client';
import { isDesktop } from '../platform';
import type {
  DocDetail,
  DocFolder,
  DocItem,
  DocSearchHit,
  DocUploadResult,
  DocVault,
} from '../api/types';
import { describeError, formatDate, formatDateTime } from '../lib/format';
import { Thumbnail } from '../documents/Thumbnail';
import { saveThumbnail, thumbnailSource } from '../documents/make-thumbnail';
import { usePermission } from '../session/permissions';
import { useSession } from '../session/session';

/** Types shown inside the app; the server marks PDFs and images only when their bytes say so. */
const PREVIEW = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
]);
/** Larger files are previewed only on request (the whole file is downloaded to show it). */
const AUTO_PREVIEW_BYTES = 15 * 1024 * 1024;
const PARALLEL_UPLOADS = 3;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const post = <T,>(url: string, body: object = {}) =>
  api.request<T>(`/api/tenant/${url}`, { method: 'POST', body });

const OUTCOME: Record<DocUploadResult['outcome'], string> = {
  created: 'Added',
  new_version: 'New version',
  unchanged: 'Unchanged (same file)',
};

interface QueuedFile {
  key: string;
  file: File;
  /** Sub-folders from an uploaded folder, e.g. "Drawings/Structural". */
  path: string | null;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
  message: string;
}

/** Uploads files a few at a time and reports each one. */
function useUploads(vault: VaultRef, onDone: () => void) {
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const running = useRef(false);
  const items = useRef<QueuedFile[]>([]);
  const target = useRef<{ folderId: string | null; documentId: string | null }>({
    folderId: null,
    documentId: null,
  });

  const update = (key: string, patch: Partial<QueuedFile>) => {
    items.current = items.current.map((q) => (q.key === key ? { ...q, ...patch } : q));
    setQueue(items.current);
  };
  const work = async () => {
    if (running.current) return;
    running.current = true;
    let uploaded = 0;
    const worker = async () => {
      for (;;) {
        const next = items.current.find((q) => q.state === 'waiting');
        if (!next) return;
        update(next.key, { state: 'uploading' });
        const params = new URLSearchParams();
        if (target.current.documentId) params.set('documentId', target.current.documentId);
        else if (target.current.folderId) params.set('folderId', target.current.folderId);
        if (next.path) params.set('path', next.path);
        try {
          const r = await api.upload<DocUploadResult>(
            `/api/tenant/${vault.kind}/${vault.id}/documents/upload?${params}`,
            next.file,
          );
          uploaded++;
          update(next.key, {
            state: 'done',
            message: `${OUTCOME[r.outcome]}${r.outcome === 'new_version' ? ` (v${r.document.versionNo})` : ''}`,
          });
          // This browser has the file: it makes the thumbnail, so nobody has to download it for one.
          if (r.outcome !== 'unchanged')
            await saveThumbnail(
              r.document.id,
              r.document.versionNo,
              next.file,
              thumbnailSource(next.file.type, next.file.name),
            );
        } catch (err) {
          update(next.key, { state: 'failed', message: describeError(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, worker));
    running.current = false;
    if (uploaded) toast.success(uploaded === 1 ? 'File uploaded' : `${uploaded} files uploaded`);
    onDone();
  };
  const add = (
    files: { file: File; path: string | null }[],
    to: { folderId: string | null; documentId?: string | null },
  ) => {
    if (files.length === 0) return;
    target.current = { folderId: to.folderId, documentId: to.documentId ?? null };
    items.current = [
      ...items.current.filter((q) => q.state !== 'done'),
      ...files.map((f, i) => ({
        key: `${Date.now()}-${i}-${f.file.name}`,
        file: f.file,
        path: f.path,
        state: 'waiting' as const,
        message: '',
      })),
    ];
    setQueue(items.current);
    void work();
  };
  const clear = () => {
    items.current = items.current.filter((q) => q.state === 'waiting' || q.state === 'uploading');
    setQueue(items.current);
  };
  return {
    queue,
    add,
    clear,
    busy: queue.some((q) => q.state === 'waiting' || q.state === 'uploading'),
  };
}

/** Files of an <input webkitdirectory>: each with the folders between the chosen folder and the file. */
function withFolders(list: FileList): { file: File; path: string | null }[] {
  return Array.from(list).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const parts = rel.split('/').slice(0, -1);
    return { file, path: parts.length ? parts.join('/') : null };
  });
}

// --- a tender's or a project's vault ---

/** Whose documents: a tender's, or a project's (docs/wave2b-plan.md step 8). */
export interface VaultRef {
  kind: 'tenders' | 'projects';
  id: string;
}

export function TenderDocuments({ tenderId }: { tenderId: string }) {
  return <VaultDocuments vault={{ kind: 'tenders', id: tenderId }} />;
}

/** The vault's folders and documents; `mayWrite` false for a project's viewers. */
export function VaultDocuments({
  vault,
  mayWrite = true,
}: {
  vault: VaultRef;
  mayWrite?: boolean;
}) {
  const qc = useQueryClient();
  const canEdit = usePermission('documents.edit') && mayWrite;
  const [folderId, setFolderId] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const listing = useQuery({
    queryKey: ['documents', vault.id],
    queryFn: () => api.request<DocVault>(`/api/tenant/${vault.kind}/${vault.id}/documents`),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['documents', vault.id] });
    void qc.invalidateQueries({ queryKey: ['document'] });
    void qc.invalidateQueries({ queryKey: ['documents-trash', vault.id] });
  };
  const uploads = useUploads(vault, refresh);
  const v = listing.data;
  const folders = useMemo(() => v?.folders ?? [], [v]);
  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  // A folder that was removed (or hidden) falls back to the top level.
  const current = folderId && byId.has(folderId) ? folderId : null;
  const q = useDeferredValue(filter.trim().toLowerCase());

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    try {
      const out = await fn();
      if (out && typeof out === 'object' && 'folders' in out)
        qc.setQueryData(['documents', vault.id], out);
      else refresh();
      if (done) toast.success(done);
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const zip = (body: { folderId?: string | null; documentIds?: string[] }) =>
    run('zip', async () => {
      const { blob, fileName } = await api.download(
        `/api/tenant/${vault.kind}/${vault.id}/documents/zip`,
        { method: 'POST', body },
      );
      saveFile(blob, fileName);
      return null;
    });

  if (listing.isPending) return <Spinner />;
  if (listing.isError) return <Alert tone="danger">{describeError(listing.error)}</Alert>;
  const vd = listing.data;
  const path: DocFolder[] = [];
  for (let id = current; id; id = byId.get(id)?.parentId ?? null) path.unshift(byId.get(id)!);
  const subfolders = folders.filter((f) => f.parentId === current);
  const docs = q
    ? vd.documents.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.tags.some((t) => t.toLowerCase().includes(q)) ||
          d.description.toLowerCase().includes(q),
      )
    : vd.documents.filter((d) => d.folderId === current);
  const empty = folders.length === 0 && vd.documents.length === 0;
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!canEdit) return;
    const files = Array.from(e.dataTransfer.files).map((file) => ({ file, path: null }));
    uploads.add(files, { folderId: current });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[17rem_1fr]">
      <Card title="Folders" className="self-start">
        <FolderTree
          folders={folders}
          documents={vd.documents}
          current={current}
          onOpen={(id) => {
            setFolderId(id);
            setOpenDoc(null);
            setShowTrash(false);
            setFilter('');
            setPicked(new Set());
          }}
        />
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          {canEdit && <NewFolder vault={vault} parentId={current} run={run} busy={busy} />}
          {canEdit && folders.length === 0 && (
            <Button
              variant="secondary"
              className="w-full"
              busy={busy === 'standard'}
              onClick={() =>
                void run(
                  'standard',
                  () => post<DocVault>(`${vault.kind}/${vault.id}/folders/standard`),
                  'Standard folders added',
                )
              }
            >
              Add the standard folders
            </Button>
          )}
          <button
            type="button"
            className={cx(
              'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2',
              showTrash && 'bg-surface-2 font-medium',
            )}
            onClick={() => {
              setShowTrash(true);
              setOpenDoc(null);
            }}
          >
            <Trash2 className="size-4" aria-hidden /> Trash ({vd.trashCount})
          </button>
        </div>
      </Card>

      <div className="min-w-0 space-y-5">
        {vd.fromTender && (
          <Alert>
            The tender's documents stay with the tender:{' '}
            <Link
              to="/tenders/$tenderId"
              params={{ tenderId: vd.fromTender.id }}
              className="font-medium underline"
            >
              {vd.fromTender.number} · {vd.fromTender.title}
            </Link>
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        {showTrash ? (
          <TrashList vault={vault} canEdit={canEdit} trashDays={vd.trashDays} onChanged={refresh} />
        ) : (
          <Card
            title={
              <span className="flex flex-wrap items-center gap-1 text-base">
                <button type="button" className="hover:underline" onClick={() => setFolderId(null)}>
                  Documents
                </button>
                {path.map((f) => (
                  <span key={f.id} className="flex items-center gap-1">
                    <span className="text-fg-subtle">/</span>
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => setFolderId(f.id)}
                    >
                      {f.name}
                    </button>
                    {f.restricted && (
                      <Lock className="size-3.5 text-warning" aria-label="restricted" />
                    )}
                  </span>
                ))}
              </span>
            }
          >
            <div
              className={cx(
                'space-y-4',
                dragging && 'rounded-md outline-2 outline-dashed outline-accent',
              )}
              onDragOver={(e) => {
                if (!canEdit) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[12rem] flex-1">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    className="pl-9"
                    aria-label="Filter documents"
                    placeholder="Find by name or tag in this tender"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
                {canEdit && (
                  <>
                    <Button onClick={() => fileInput.current?.click()} disabled={uploads.busy}>
                      <Upload className="size-4" aria-hidden /> Upload files
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => folderInput.current?.click()}
                      disabled={uploads.busy}
                    >
                      <FolderOpen className="size-4" aria-hidden /> Upload a folder
                    </Button>
                  </>
                )}
                {picked.size > 0 ? (
                  <Button
                    variant="secondary"
                    busy={busy === 'zip'}
                    onClick={() => void zip({ documentIds: [...picked] })}
                  >
                    <Download className="size-4" aria-hidden /> Download {picked.size} (ZIP)
                  </Button>
                ) : (
                  vd.documents.length > 0 && (
                    <Button
                      variant="secondary"
                      busy={busy === 'zip'}
                      onClick={() => void zip({ folderId: current })}
                    >
                      <Download className="size-4" aria-hidden />{' '}
                      {current ? 'Download folder (ZIP)' : 'Download all (ZIP)'}
                    </Button>
                  )
                )}
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-label="Files to upload"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []).map((file) => ({
                    file,
                    path: null,
                  }));
                  e.target.value = '';
                  uploads.add(files, { folderId: current });
                }}
              />
              <input
                ref={folderInput}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-label="Folder to upload"
                {...({ webkitdirectory: '' } as Record<string, string>)}
                onChange={(e) => {
                  const files = e.target.files ? withFolders(e.target.files) : [];
                  e.target.value = '';
                  uploads.add(files, { folderId: current });
                }}
              />
              <UploadQueue queue={uploads.queue} onClear={uploads.clear} />
              {current && canEdit && !q && (
                <FolderActions
                  folder={byId.get(current)!}
                  folders={vd.folders}
                  canRestrict={vd.canSeeRestricted}
                  run={run}
                  busy={busy}
                  onDeleted={() => setFolderId(byId.get(current)?.parentId ?? null)}
                />
              )}
              {empty ? (
                <EmptyState title="No documents yet.">
                  {canEdit &&
                    'Add the standard folders, then upload the tender notice, drawings and addenda (or drop files here).'}
                </EmptyState>
              ) : (
                <DocumentList
                  subfolders={q ? [] : subfolders}
                  documents={docs}
                  folders={byId}
                  showFolder={Boolean(q)}
                  picked={picked}
                  onPick={(id) => {
                    const next = new Set(picked);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    setPicked(next);
                  }}
                  onOpenFolder={(id) => {
                    setFolderId(id);
                    setPicked(new Set());
                  }}
                  onOpenDoc={setOpenDoc}
                  openDoc={openDoc}
                />
              )}
              {canEdit && !empty && (
                <p className="text-xs text-fg-subtle">
                  Drop files here to upload them into this folder. A file with the name of a
                  document already here becomes its next version. Up to {formatBytes(vd.maxBytes)}{' '}
                  each.
                </p>
              )}
            </div>
          </Card>
        )}
        {openDoc && !showTrash && (
          <DocumentPanel
            key={openDoc}
            documentId={openDoc}
            hasThumbnail={vd.documents.find((x) => x.id === openDoc)?.hasThumbnail ?? true}
            folders={folders}
            canEdit={canEdit}
            onClose={() => setOpenDoc(null)}
            onChanged={refresh}
            onNewVersion={(file) =>
              uploads.add([{ file, path: null }], { folderId: current, documentId: openDoc })
            }
          />
        )}
      </div>
    </div>
  );
}

type Run = (key: string, fn: () => Promise<unknown>, done?: string) => Promise<boolean>;

function FolderTree({
  folders,
  documents,
  current,
  onOpen,
}: {
  folders: DocFolder[];
  documents: DocItem[];
  current: string | null;
  onOpen: (id: string | null) => void;
}) {
  const count = useMemo(() => {
    const m = new Map<string | null, number>();
    for (const d of documents) m.set(d.folderId, (m.get(d.folderId) ?? 0) + 1);
    return m;
  }, [documents]);
  const children = (parent: string | null, depth: number): ReactNode =>
    folders
      .filter((f) => f.parentId === parent)
      .map((f) => (
        <li key={f.id}>
          <button
            type="button"
            className={cx(
              'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-surface-2',
              current === f.id && 'bg-accent/10 font-medium text-accent',
            )}
            style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
            onClick={() => onOpen(f.id)}
          >
            {current === f.id ? (
              <FolderOpen className="size-4 shrink-0" aria-hidden />
            ) : (
              <Folder className="size-4 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            {f.restricted && (
              <Lock className="size-3.5 shrink-0 text-warning" aria-label="restricted" />
            )}
            {count.get(f.id) ? (
              <span className="text-xs text-fg-subtle">{count.get(f.id)}</span>
            ) : null}
          </button>
          <ul>{children(f.id, depth + 1)}</ul>
        </li>
      ));
  return (
    <nav aria-label="Document folders">
      <ul className="space-y-0.5">
        <li>
          <button
            type="button"
            className={cx(
              'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-surface-2',
              current === null && 'bg-accent/10 font-medium text-accent',
            )}
            onClick={() => onOpen(null)}
          >
            <FileText className="size-4" aria-hidden />
            <span className="flex-1">Top level</span>
            {count.get(null) ? (
              <span className="text-xs text-fg-subtle">{count.get(null)}</span>
            ) : null}
          </button>
        </li>
        {children(null, 0)}
      </ul>
    </nav>
  );
}

function NewFolder({
  vault,
  parentId,
  run,
  busy,
}: {
  vault: VaultRef;
  parentId: string | null;
  run: Run;
  busy: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open)
    return (
      <Button variant="secondary" className="w-full" onClick={() => setOpen(true)}>
        <FolderPlus className="size-4" aria-hidden /> New folder
      </Button>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(
      'folder',
      () => post<DocVault>(`${vault.kind}/${vault.id}/folders`, { parentId, name }),
      `Folder ${name.trim()} created`,
    ).then((ok) => {
      if (ok) {
        setName('');
        setOpen(false);
      }
    });
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Field label="Folder name" hint={parentId ? 'Inside the open folder.' : 'At the top level.'}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
          maxLength={120}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" busy={busy === 'folder'}>
          Create
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FolderActions({
  folder,
  folders,
  canRestrict,
  run,
  busy,
  onDeleted,
}: {
  folder: DocFolder;
  folders: DocFolder[];
  canRestrict: boolean;
  run: Run;
  busy: string | null;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  // Anywhere but inside itself.
  const inside = new Set([folder.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of folders)
      if (f.parentId && inside.has(f.parentId) && !inside.has(f.id)) {
        inside.add(f.id);
        grew = true;
      }
  }
  const targets = folderOptions(folders).filter((o) => !inside.has(o.id));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
      {renaming ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              'rename-folder',
              () => post<DocVault>(`folders/${folder.id}`, { rowVersion: folder.rowVersion, name }),
              'Folder renamed',
            ).then((ok) => ok && setRenaming(false));
          }}
        >
          <Input
            aria-label="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-64"
            autoFocus
          />
          <Button type="submit" busy={busy === 'rename-folder'}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <span className="mr-auto text-fg-muted">
            {folder.restricted
              ? 'Restricted: only roles that see bid pricing can see this folder.'
              : 'Folder'}
          </span>
          <Button variant="ghost" onClick={() => setRenaming(true)}>
            Rename
          </Button>
          <Select
            aria-label="Move folder to"
            className="w-56"
            value=""
            disabled={busy === 'move-folder'}
            onChange={(e) => {
              const to = e.target.value;
              if (to)
                void run(
                  'move-folder',
                  () =>
                    post<DocVault>(`folders/${folder.id}`, {
                      rowVersion: folder.rowVersion,
                      parentId: to === 'top' ? null : to,
                    }),
                  `${folder.name} moved`,
                );
            }}
          >
            <option value="">Move to…</option>
            {folder.parentId && <option value="top">The top level</option>}
            {targets
              .filter((o) => o.id !== folder.parentId)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
          </Select>
          {canRestrict && (
            <Button
              variant="ghost"
              busy={busy === 'restrict'}
              onClick={() =>
                void run(
                  'restrict',
                  () =>
                    post<DocVault>(`folders/${folder.id}`, {
                      rowVersion: folder.rowVersion,
                      restricted: !folder.restricted,
                    }),
                  folder.restricted ? 'Restriction lifted' : `${folder.name} restricted`,
                )
              }
            >
              <Lock className="size-4" aria-hidden />{' '}
              {folder.restricted ? 'Lift restriction' : 'Restrict'}
            </Button>
          )}
          <Button
            variant="ghost"
            busy={busy === 'delete-folder'}
            onClick={async () => {
              if (
                !(await confirm({
                  title: `Delete folder ${folder.name}?`,
                  body: 'Only an empty folder can be deleted; move or trash what is in it first.',
                  confirmLabel: 'Delete the folder',
                  tone: 'danger',
                }))
              )
                return;
              if (
                await run(
                  'delete-folder',
                  () => post<DocVault>(`folders/${folder.id}/delete`),
                  `Folder ${folder.name} deleted`,
                )
              )
                onDeleted();
            }}
          >
            <Trash2 className="size-4" aria-hidden /> Delete folder
          </Button>
        </>
      )}
    </div>
  );
}

function UploadQueue({ queue, onClear }: { queue: QueuedFile[]; onClear: () => void }) {
  if (queue.length === 0) return null;
  const done = queue.filter((q) => q.state === 'done').length;
  const failed = queue.filter((q) => q.state === 'failed').length;
  const pending = queue.length - done - failed;
  return (
    <div className="rounded-md border border-line" aria-label="Uploads" role="region">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-sm">
        <span>
          {pending > 0
            ? `Uploading: ${done + failed} of ${queue.length} done`
            : `Uploaded ${done} of ${queue.length}`}
          {failed > 0 && <span className="text-danger">, {failed} failed</span>}
        </span>
        {pending === 0 && (
          <button
            type="button"
            aria-label="Clear uploads"
            className="text-fg-muted hover:text-fg"
            onClick={onClear}
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <ul className="max-h-48 overflow-y-auto text-sm">
        {queue.map((q) => (
          <li key={q.key} className="flex items-center justify-between gap-3 px-3 py-1">
            <span className="min-w-0 truncate">
              {q.path && <span className="text-fg-subtle">{q.path}/</span>}
              {q.file.name}
            </span>
            <span
              className={cx(
                'shrink-0 text-xs',
                q.state === 'failed'
                  ? 'text-danger'
                  : q.state === 'done'
                    ? 'text-success'
                    : 'text-fg-muted',
              )}
            >
              {q.state === 'waiting'
                ? 'Waiting'
                : q.state === 'uploading'
                  ? 'Uploading…'
                  : q.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocumentList({
  subfolders,
  documents,
  folders,
  showFolder,
  picked,
  onPick,
  onOpenFolder,
  onOpenDoc,
  openDoc,
}: {
  subfolders: DocFolder[];
  documents: DocItem[];
  folders: Map<string, DocFolder>;
  showFolder: boolean;
  picked: Set<string>;
  onPick: (id: string) => void;
  onOpenFolder: (id: string) => void;
  onOpenDoc: (id: string) => void;
  openDoc: string | null;
}) {
  if (subfolders.length === 0 && documents.length === 0)
    return (
      <EmptyState title={showFolder ? 'Nothing matches.' : 'This folder is empty.'}>
        {showFolder
          ? 'Try another name, tag or word.'
          : 'Files and folders added here appear in this list.'}
      </EmptyState>
    );
  return (
    <Table minWidth="40rem">
      <thead>
        <tr>
          <th className="w-8" />
          <th>Name</th>
          <th className="text-right">Size</th>
          <th>Uploaded</th>
        </tr>
      </thead>
      <tbody aria-label="Documents">
        {subfolders.map((f) => (
          <tr key={f.id}>
            <td />
            <td colSpan={3}>
              <button
                type="button"
                className="flex items-center gap-2 font-medium hover:underline"
                onClick={() => onOpenFolder(f.id)}
              >
                <Folder className="size-4 text-fg-muted" aria-hidden /> {f.name}
                {f.restricted && <Lock className="size-3.5 text-warning" aria-label="restricted" />}
              </button>
            </td>
          </tr>
        ))}
        {documents.map((d) => (
          <tr key={d.id} className={cx(openDoc === d.id && 'bg-accent/5')}>
            <td>
              <input
                type="checkbox"
                aria-label={`Select ${d.name}`}
                checked={picked.has(d.id)}
                onChange={() => onPick(d.id)}
              />
            </td>
            <td className="min-w-0">
              <div className="flex items-start gap-2">
                <Thumbnail documentId={d.id} versionNo={d.versionNo} has={d.hasThumbnail} />
                <div className="min-w-0">
                  <button
                    type="button"
                    className="text-left font-medium text-accent hover:underline"
                    onClick={() => onOpenDoc(d.id)}
                  >
                    {d.name}
                  </button>{' '}
                  {d.versionNo > 1 && <Badge tone="neutral">v{d.versionNo}</Badge>}
                  {(d.tags.length > 0 || showFolder) && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-fg-muted">
                      {showFolder && (
                        <span>{d.folderId ? folders.get(d.folderId)?.name : 'Top level'}</span>
                      )}
                      {d.tags.map((t) => (
                        <Badge key={t} tone="accent">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </td>
            <td className="whitespace-nowrap text-right tabular-nums">{formatBytes(d.size)}</td>
            <td className="whitespace-nowrap text-xs text-fg-muted">
              {formatDateTime(d.uploadedAt)}
              {d.uploadedBy && <div>{d.uploadedBy}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Shows a PDF, image or text file inside the app, from bytes fetched with the user's session. */
/** Whether a PDF's words were read for search. */
function TextStatus({ text }: { text: NonNullable<DocDetail['versions'][number]['text']> }) {
  const say =
    text.status === 'done'
      ? text.pages
        ? `Searchable: the text of ${text.pages} page${text.pages === 1 ? '' : 's'} was read.`
        : 'Searchable.'
      : text.status === 'pending' || text.status === 'working'
        ? 'Its text is being read for search.'
        : `Found by its name only: its text could not be read${text.note ? ` (${text.note})` : ''}. A scanned PDF has no text to read.`;
  return (
    <p className="text-xs text-fg-muted" data-testid="text-status">
      {say}
    </p>
  );
}

function Preview({
  documentId,
  version,
  mime,
  size,
  onFile,
}: {
  documentId: string;
  version: number;
  mime: string;
  size: number;
  /** The file, once fetched for the preview (to make a missing thumbnail from). */
  onFile?: ((blob: Blob) => void) | undefined;
}) {
  const [asked, setAsked] = useState(size <= AUTO_PREVIEW_BYTES);
  const file = useQuery({
    queryKey: ['document-file', documentId, version],
    queryFn: async () => {
      const { blob } = await api.download(
        `/api/tenant/documents/${documentId}/file?version=${version}`,
      );
      // The type comes from the server's check of the bytes, never from the response alone.
      const typed = new Blob([blob], { type: mime });
      onFile?.(typed);
      return mime.startsWith('text/')
        ? { text: (await typed.slice(0, 200_000).text()) as string, url: null }
        : { text: null, url: URL.createObjectURL(typed) };
    },
    enabled: asked && PREVIEW.has(mime) && !(mime === 'application/pdf' && isDesktop()),
    staleTime: Infinity,
    gcTime: 0,
  });
  const url = file.data?.url;
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (!PREVIEW.has(mime))
    return (
      <p className="text-sm text-fg-muted">
        No preview for this type of file; download it to open it.
      </p>
    );
  // [Guessing] the desktop shell's built-in PDF viewer is off; until that is checked, PDFs open by download there.
  if (mime === 'application/pdf' && isDesktop())
    return <p className="text-sm text-fg-muted">Download the PDF to open it.</p>;
  if (!asked)
    return (
      <Button variant="secondary" onClick={() => setAsked(true)}>
        Show preview ({formatBytes(size)})
      </Button>
    );
  if (file.isPending) return <Spinner label="Loading preview" />;
  if (file.isError) return <Alert tone="danger">{describeError(file.error)}</Alert>;
  if (file.data.text !== null)
    return (
      <pre className="max-h-[32rem] overflow-auto rounded-md border border-line bg-surface-2 p-3 text-xs">
        {file.data.text}
      </pre>
    );
  return mime === 'application/pdf' ? (
    <iframe
      title="Preview"
      src={file.data.url!}
      className="h-[70vh] w-full rounded-md border border-line"
    />
  ) : (
    <img
      src={file.data.url!}
      alt="Preview"
      className="max-h-[70vh] max-w-full rounded-md border border-line"
    />
  );
}

function DocumentPanel({
  documentId,
  hasThumbnail,
  folders,
  canEdit,
  onClose,
  onChanged,
  onNewVersion,
}: {
  documentId: string;
  hasThumbnail: boolean;
  folders: DocFolder[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
  onNewVersion: (file: File) => void;
}) {
  const qc = useQueryClient();
  const doc = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api.request<DocDetail>(`/api/tenant/documents/${documentId}`),
  });
  const tags = useQuery({
    queryKey: ['document-tags'],
    queryFn: () => api.request<string[]>('/api/tenant/document-tags'),
    enabled: canEdit,
  });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versionInput = useRef<HTMLInputElement>(null);

  if (doc.isPending) return <Spinner />;
  if (doc.isError) return <Alert tone="danger">{describeError(doc.error)}</Alert>;
  const d = doc.data;
  const latest = d.versions[0]!;
  const act = async (key: string, fn: () => Promise<DocDetail>) => {
    setBusy(key);
    setError(null);
    try {
      qc.setQueryData(['document', documentId], await fn());
      void qc.invalidateQueries({ queryKey: ['document-tags'] });
      onChanged();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const download = (version: number) =>
    void (async () => {
      setBusy(`download-${version}`);
      setError(null);
      try {
        const { blob, fileName } = await api.download(
          `/api/tenant/documents/${documentId}/file?version=${version}`,
        );
        saveFile(blob, fileName);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(null);
      }
    })();

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {d.name} <Badge tone="neutral">v{d.versionNo}</Badge>
        </span>
      }
      actions={
        <button
          type="button"
          aria-label="Close document"
          className="text-fg-muted hover:text-fg"
          onClick={onClose}
        >
          <X className="size-5" aria-hidden />
        </button>
      }
    >
      <div className="space-y-4" aria-label={`Document ${d.name}`} role="region">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <span>{['Documents', ...d.path.map((p) => p.name)].join(' / ')}</span>
          {d.tags.map((t) => (
            <Badge key={t} tone="accent">
              {t}
            </Badge>
          ))}
        </div>
        {d.description && <p className="whitespace-pre-wrap text-sm">{d.description}</p>}
        <div className="flex flex-wrap gap-2">
          <Button busy={busy === `download-${d.versionNo}`} onClick={() => download(d.versionNo)}>
            <Download className="size-4" aria-hidden /> Download
          </Button>
          {canEdit && (
            <>
              <Button variant="secondary" onClick={() => versionInput.current?.click()}>
                <Upload className="size-4" aria-hidden /> Upload new version
              </Button>
              <Button variant="secondary" onClick={() => setEditing(!editing)}>
                Edit details
              </Button>
              <Button
                variant="ghost"
                busy={busy === 'delete'}
                onClick={() =>
                  void act('delete', () => post<DocDetail>(`documents/${documentId}/delete`)).then(
                    (ok) => {
                      if (!ok) return;
                      toast.success(`${d.name} moved to the trash`);
                      onClose();
                    },
                  )
                }
              >
                <Trash2 className="size-4" aria-hidden /> Move to trash
              </Button>
            </>
          )}
          <input
            ref={versionInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label="New version file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onNewVersion(f);
            }}
          />
        </div>
        {editing && (
          <EditDocument
            doc={d}
            folders={folders}
            knownTags={tags.data ?? []}
            busy={busy === 'edit'}
            onSave={(body) =>
              void act('edit', () =>
                post<DocDetail>(`documents/${documentId}`, { rowVersion: d.rowVersion, ...body }),
              ).then((ok) => {
                if (!ok) return;
                setEditing(false);
                toast.success('Details saved');
              })
            }
            onCancel={() => setEditing(false)}
          />
        )}
        {latest.text && <TextStatus text={latest.text} />}
        <Preview
          documentId={documentId}
          version={latest.versionNo}
          mime={latest.mime}
          size={latest.size}
          onFile={
            canEdit && !hasThumbnail
              ? (blob) =>
                  void saveThumbnail(
                    documentId,
                    latest.versionNo,
                    blob,
                    thumbnailSource(latest.mime),
                  ).then((ok) => ok && onChanged())
              : undefined
          }
        />
        <div>
          <h3 className="mb-2 text-sm font-semibold">Versions</h3>
          <ol className="divide-y divide-line text-sm" aria-label="Versions">
            {d.versions.map((ver) => (
              <li
                key={ver.versionNo}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="min-w-0">
                  <span className="font-medium">v{ver.versionNo}</span>{' '}
                  <span className="text-fg-muted">
                    {formatDateTime(ver.uploadedAt)}
                    {ver.uploadedBy && `, ${ver.uploadedBy}`} · {formatBytes(ver.size)}
                    {ver.originalName !== d.name && ` · ${ver.originalName}`}
                  </span>
                  {ver.note && <div className="text-xs">{ver.note}</div>}
                  {ver.scanStatus === 'not_scanned' && (
                    <div className="text-xs text-fg-subtle">Not virus-scanned</div>
                  )}
                </span>
                <Button
                  variant="ghost"
                  aria-label={`Download version ${ver.versionNo}`}
                  busy={busy === `download-${ver.versionNo}`}
                  onClick={() => download(ver.versionNo)}
                >
                  <Download className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Card>
  );
}

/** Folders as an indented list for a <select>, the tree's order. */
function folderOptions(folders: DocFolder[]) {
  const out: { id: string; label: string }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === parent)) {
      out.push({
        id: f.id,
        label: `${' '.repeat(depth)}${f.name}${f.restricted ? ' (restricted)' : ''}`,
      });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function EditDocument({
  doc,
  folders,
  knownTags,
  busy,
  onSave,
  onCancel,
}: {
  doc: DocDetail;
  folders: DocFolder[];
  knownTags: string[];
  busy: boolean;
  onSave: (body: {
    name: string;
    description: string;
    tags: string[];
    folderId: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState({
    name: doc.name,
    description: doc.description,
    tags: doc.tags.join(', '),
    folderId: doc.folderId ?? '',
  });
  return (
    <form
      className="space-y-3 rounded-md border border-line bg-surface-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          name: v.name,
          description: v.description,
          tags: v.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          folderId: v.folderId || null,
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Document name">
          <Input
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
            required
            maxLength={255}
          />
        </Field>
        <Field label="Folder">
          <Select value={v.folderId} onChange={(e) => setV({ ...v, folderId: e.target.value })}>
            <option value="">Top level</option>
            {folderOptions(folders).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Tags" hint="Separated by commas, e.g. Structural, Rev C.">
        <Input
          value={v.tags}
          onChange={(e) => setV({ ...v, tags: e.target.value })}
          list="document-tags"
        />
      </Field>
      <datalist id="document-tags">
        {knownTags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <Field label="Description">
        <Textarea
          rows={2}
          value={v.description}
          onChange={(e) => setV({ ...v, description: e.target.value })}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TrashList({
  vault,
  canEdit,
  trashDays,
  onChanged,
}: {
  vault: VaultRef;
  canEdit: boolean;
  trashDays: number | null;
  onChanged: () => void;
}) {
  const isAdmin = useSession().user?.role === 'admin';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();
  const act = async (key: string, path: string, done: string) => {
    setBusy(key);
    setError(null);
    try {
      await post(path);
      onChanged();
      toast.success(done);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  const goesOn = (deletedAt: string | null) =>
    trashDays && deletedAt
      ? formatDate(new Date(new Date(deletedAt).getTime() + trashDays * 86_400_000).toISOString())
      : null;
  const trash = useQuery({
    queryKey: ['documents-trash', vault.id],
    queryFn: () => api.request<DocItem[]>(`/api/tenant/${vault.kind}/${vault.id}/documents/trash`),
  });
  const restore = async (id: string, name: string) => {
    setBusy(id);
    setError(null);
    try {
      await post(`documents/${id}/restore`);
      onChanged();
      toast.success(`${name} restored`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card
      title="Trash"
      actions={
        isAdmin &&
        (trash.data?.length ?? 0) > 0 && (
          <Button
            variant="secondary"
            busy={busy === 'all'}
            onClick={async () => {
              const n = trash.data!.length;
              if (
                !(await confirm({
                  title: `Delete all ${n} for good?`,
                  body: 'Every version of every document in the trash is deleted. This cannot be undone.',
                  confirmLabel: 'Delete for good',
                  cancelLabel: 'Keep',
                  tone: 'danger',
                }))
              )
                return;
              await act(
                'all',
                `${vault.kind}/${vault.id}/documents/trash/empty`,
                `${n} ${n === 1 ? 'document' : 'documents'} deleted for good`,
              );
            }}
          >
            Empty trash
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-fg-muted">
        Documents moved to the trash keep every version and can be restored.{' '}
        {trashDays
          ? `They are deleted for good ${trashDays} days after going to the trash (your admin's setting).`
          : 'They stay until your admin deletes them for good.'}
      </p>
      {error && (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {trash.isPending ? (
        <Spinner />
      ) : trash.isError ? (
        <Alert tone="danger">{describeError(trash.error)}</Alert>
      ) : trash.data.length === 0 ? (
        <EmptyState title="The trash is empty.">
          Documents moved to the trash wait here until they are restored or deleted for good.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Trash">
          {trash.data.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="font-medium">{d.name}</span>
                <span className="block text-xs text-fg-muted">
                  Removed {d.deletedAt ? formatDateTime(d.deletedAt) : ''} · {formatBytes(d.size)}
                  {goesOn(d.deletedAt) && ` · deleted for good on ${goesOn(d.deletedAt)}`}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                {canEdit && (
                  <Button
                    variant="secondary"
                    busy={busy === d.id}
                    onClick={() => void restore(d.id, d.name)}
                  >
                    <RotateCcw className="size-4" aria-hidden /> Restore
                  </Button>
                )}
                {isAdmin && (
                  <Button
                    variant="ghost"
                    busy={busy === `purge-${d.id}`}
                    aria-label={`Delete ${d.name} for good`}
                    onClick={async () => {
                      if (
                        !(await confirm({
                          title: `Delete ${d.name} for good?`,
                          body: 'Every version of it is deleted. This cannot be undone.',
                          confirmLabel: 'Delete for good',
                          cancelLabel: 'Keep',
                          tone: 'danger',
                        }))
                      )
                        return;
                      await act(
                        `purge-${d.id}`,
                        `documents/${d.id}/purge`,
                        `${d.name} deleted for good`,
                      );
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- every tender's documents ---

/** The passage of a PDF a search found, its words marked (the server puts them between \u0002 and \u0003). */
function Snippet({ text }: { text: string }) {
  // Plain text and marked words alternate: "before \u0002word\u0003 after".
  const parts: { text: string; marked: boolean }[] = [];
  for (const chunk of text.split('\u0002')) {
    const end = chunk.indexOf('\u0003');
    if (end < 0) parts.push({ text: chunk, marked: false });
    else
      parts.push(
        { text: chunk.slice(0, end), marked: true },
        { text: chunk.slice(end + 1), marked: false },
      );
  }
  return (
    <p className="mt-1 max-w-xl text-xs text-fg-muted" data-testid="snippet">
      …
      {parts.map((p, i) =>
        p.marked ? (
          <mark key={i} className="rounded bg-warning/20 px-0.5 text-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
      …
    </p>
  );
}

export function DocumentsScreen() {
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const q = useDeferredValue(search.trim());
  const params = new URLSearchParams({ limit: '100' });
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  const results = useQuery({
    queryKey: ['document-search', params.toString()],
    queryFn: () =>
      api.request<{ items: DocSearchHit[]; hasMore: boolean }>(`/api/tenant/documents?${params}`),
    placeholderData: keepPreviousData,
  });
  const tags = useQuery({
    queryKey: ['document-tags'],
    queryFn: () => api.request<string[]>('/api/tenant/document-tags'),
  });
  const [error, setError] = useState<string | null>(null);
  const download = async (d: DocSearchHit) => {
    setError(null);
    try {
      const { blob, fileName } = await api.download(`/api/tenant/documents/${d.id}/file`);
      saveFile(blob, fileName);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Documents"
        subtitle="Every tender's documents, and those of the projects you are on. Open a tender's Documents tab or a project's Documents to upload and organise them."
      />
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            type="search"
            className="pl-9"
            aria-label="Search documents"
            placeholder="Name, description or tag"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          aria-label="Tag"
          className="w-48"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        >
          <option value="">Any tag</option>
          {tags.data?.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        {results.isPending ? (
          <Spinner />
        ) : results.isError ? (
          <Alert tone="danger">{describeError(results.error)}</Alert>
        ) : results.data.items.length === 0 ? (
          <EmptyState title={q || tag ? 'Nothing matches.' : 'No documents yet.'}>
            {q || tag
              ? 'Try another word or tag.'
              : "Upload documents from a tender's Documents tab or a project's Documents."}
          </EmptyState>
        ) : (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Document</th>
                <th>Tender or project</th>
                <th className="text-right">Size</th>
                <th>Uploaded</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="Search results">
              {results.data.items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className="flex items-start gap-2">
                      <Thumbnail documentId={d.id} versionNo={d.versionNo} has={d.hasThumbnail} />
                      <div className="min-w-0">
                        <div className="font-medium">
                          {d.name} {d.versionNo > 1 && <Badge tone="neutral">v{d.versionNo}</Badge>}
                        </div>
                        <div className="flex flex-wrap gap-1 text-xs text-fg-muted">
                          {d.folder ?? 'Top level'}
                          {d.tags.map((t) => (
                            <Badge key={t} tone="accent">
                              {t}
                            </Badge>
                          ))}
                        </div>
                        {d.snippet && <Snippet text={d.snippet} />}
                      </div>
                    </div>
                  </td>
                  <td>
                    {d.tenderId && d.tender ? (
                      <>
                        <Link
                          to="/tenders/$tenderId"
                          params={{ tenderId: d.tenderId }}
                          className="text-accent hover:underline"
                        >
                          {d.tender.title}
                        </Link>
                        <div className="font-mono text-xs text-fg-muted">{d.tender.number}</div>
                      </>
                    ) : d.projectId && d.project ? (
                      <>
                        <Link
                          to="/projects/$projectId/documents"
                          params={{ projectId: d.projectId }}
                          className="text-accent hover:underline"
                        >
                          {d.project.name}
                        </Link>
                        <div className="font-mono text-xs text-fg-muted">
                          Project {d.project.number}
                        </div>
                      </>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {formatBytes(d.size)}
                  </td>
                  <td className="whitespace-nowrap text-xs text-fg-muted">
                    {formatDate(d.uploadedAt)}
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      aria-label={`Download ${d.name}`}
                      onClick={() => void download(d)}
                    >
                      <Download className="size-4" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {results.data?.hasMore && (
          <p className="mt-3 text-xs text-fg-muted">
            Showing the newest 100; narrow the search to see others.
          </p>
        )}
      </Card>
    </div>
  );
}
