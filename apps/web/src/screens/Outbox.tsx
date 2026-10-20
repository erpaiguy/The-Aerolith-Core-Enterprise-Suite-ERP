// What this phone is keeping until there is signal (docs/wave6-plan.md step 4), oldest first; a refused one with its
// reason, to discard after fixing it on its screen.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useState } from 'react';
import { outbox, usePending } from '../offline';

export function OutboxScreen() {
  const items = usePending();
  const confirm = useConfirm();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Outbox"
        subtitle="Forms saved on this phone while there was no signal. They are sent in order when it returns."
        actions={
          <Button
            type="button"
            onClick={async () => {
              const r = await outbox.flush();
              setNote(
                r.stopped
                  ? `${r.sent} sent; one was refused and waits below.`
                  : navigator.onLine
                    ? `${r.sent} sent.`
                    : 'Still no signal.',
              );
            }}
          >
            Send now
          </Button>
        }
      />
      {note && <Alert tone="info">{note}</Alert>}
      <Card>
        {items.length === 0 && (
          <EmptyState title="Nothing waiting.">
            Forms saved here without signal show until they are sent.
          </EmptyState>
        )}
        <ol className="space-y-2 text-sm" aria-label="Waiting to be sent">
          {items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.label}</span>
              <span className="text-fg-muted">{new Date(p.createdAt).toLocaleString('en-IN')}</span>
              {p.error ? (
                <>
                  <Badge tone="danger">refused: {p.error}</Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={async () => {
                      if (
                        !(await confirm({
                          title: `Discard ${p.label}?`,
                          body: 'It is removed from this phone and never sent. Enter it again on its screen once it is fixed.',
                          confirmLabel: 'Discard the form',
                          tone: 'danger',
                        }))
                      )
                        return;
                      await outbox.discard(p.id);
                      toast.success(`${p.label} discarded`);
                    }}
                  >
                    Discard
                  </Button>
                </>
              ) : (
                <Badge tone="warning">waiting</Badge>
              )}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
