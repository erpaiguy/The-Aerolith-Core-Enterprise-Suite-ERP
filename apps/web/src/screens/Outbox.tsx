// What this phone is keeping until there is signal (docs/wave6-plan.md step 4), oldest first; a refused one with its
// reason, to discard after fixing it on its screen.
import { Alert, Badge, Button, Card, PageHeader } from '@aerolith/ui';
import { useState } from 'react';
import { outbox, usePending } from '../offline';

export function OutboxScreen() {
  const items = usePending();
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
        <ol className="space-y-2 text-sm" aria-label="Waiting to be sent">
          {items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.label}</span>
              <span className="text-fg-muted">{new Date(p.createdAt).toLocaleString('en-IN')}</span>
              {p.error ? (
                <>
                  <Badge tone="danger">refused: {p.error}</Badge>
                  <Button type="button" variant="ghost" onClick={() => void outbox.discard(p.id)}>
                    Discard
                  </Button>
                </>
              ) : (
                <Badge tone="warning">waiting</Badge>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="text-fg-muted">Nothing waiting.</li>}
        </ol>
      </Card>
    </div>
  );
}
