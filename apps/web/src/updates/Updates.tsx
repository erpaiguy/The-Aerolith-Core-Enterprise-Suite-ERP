// A new release, where people will see it (docs/wave9-plan.md step 9b.4): on the status bar and on the sign-in
// screen, with the release notes. In the desktop app, once the update is downloaded and checked, "Restart and update";
// in a browser the server's administrator updates the server and everyone gets the new version on their next visit.
import type { UpdateStatus } from '@aerolith/shared';
import { Badge, Button, Dialog } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { formatDate } from '../lib/format';
import { desktop } from '../platform';

export interface DesktopUpdateState {
  mode: 'auto' | 'manual';
  current: string;
  checking: boolean;
  checkedAt: string | null;
  ready: { version: string; notes: string[]; required: boolean } | null;
  note: string | null;
}

/** What the server knows about releases; open to anyone, so it works before signing in. */
export function useUpdateStatus() {
  return useQuery({
    queryKey: ['updates'],
    queryFn: () => api.request<UpdateStatus>('/api/updates', { auth: false }),
    staleTime: 3_600_000,
    refetchInterval: 3_600_000,
    retry: false,
  });
}

/** The desktop app's own update state, live; null in a browser or an older desktop build. */
export function useDesktopUpdate(): DesktopUpdateState | null {
  const bridge = desktop()?.updates;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    void bridge.get().then((s) => setState(s as DesktopUpdateState));
    return bridge.onChange((s) => setState(s as DesktopUpdateState));
  }, [bridge]);
  return state;
}

function Notes({ version, date, notes }: { version: string; date?: string; notes: string[] }) {
  return (
    <div className="space-y-2">
      <p className="text-fg-muted">
        Version {version}
        {date ? `, released ${formatDate(date)}` : ''}.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

/** The notice itself: nothing when this is the latest. */
export function ReleaseNotice({ place }: { place: 'status' | 'sign-in' }) {
  const status = useUpdateStatus().data;
  const local = useDesktopUpdate();
  const [open, setOpen] = useState(false);
  const ready = local?.ready ?? null;
  const latest = status?.available ? status.latest : null;
  if (!ready && !latest) return null;
  const version = ready?.version ?? latest!.version;
  const required = ready?.required ?? status?.required ?? false;
  const label = ready
    ? `Version ${version} is ready to install`
    : `Version ${version} is available`;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          place === 'status'
            ? 'inline-flex items-center gap-1 font-medium text-accent underline'
            : 'mx-auto mt-3 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-fg'
        }
      >
        <Download className="size-3.5" aria-hidden />
        {label}
        {required && <Badge tone="danger">Required</Badge>}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`What's new in ${version}`}
        description={
          required
            ? 'This version fixes something important: please update as soon as you can.'
            : undefined
        }
        footer={
          ready ? (
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                {local?.mode === 'auto' ? 'Install when I close the app' : 'Later'}
              </Button>
              <Button onClick={() => void desktop()?.updates?.restart()}>Restart and update</Button>
            </>
          ) : (
            <Button onClick={() => setOpen(false)}>Close</Button>
          )
        }
      >
        <Notes
          version={version}
          {...(latest?.date ? { date: latest.date } : {})}
          notes={ready?.notes ?? latest?.notes ?? []}
        />
        {!ready && (
          <p className="mt-4 text-fg-muted">
            {desktop()
              ? 'The desktop app downloads it by itself when updates are automatic, or from Settings when they are manual.'
              : 'Your administrator updates the server; everyone gets the new version the next time they open the app.'}
          </p>
        )}
      </Dialog>
    </>
  );
}
