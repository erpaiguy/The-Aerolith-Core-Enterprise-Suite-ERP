// The recipient's page for a transmittal (docs/wave5-plan.md step 3): no account, only the expiring link. They see
// what was sent and download it, acknowledge receipt with their name, and for a review answer with a code, a comment
// and one file. Everything they do is recorded against the transmittal.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  toast,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, saveFile } from '../../api/client';
import { describeError } from '../../lib/format';
import { numberLocale } from '../../lib/locale';

interface View {
  project: string;
  number: string;
  subject: string;
  recipient: string;
  purpose: 'information' | 'review' | 'construction' | 'record';
  notes: string;
  issuedOn: string;
  dueOn: string | null;
  status: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  respondedAt: string | null;
  respondedBy: string | null;
  response: string | null;
  responseCode: string | null;
  expiresAt: string;
  items: { id: string; name: string; versionNo: number; copies: number; remark: string }[];
  codes: { code: string; label: string }[];
}

const PURPOSE = {
  information: 'For information',
  review: 'For review',
  construction: 'For construction',
  record: 'For record',
};

export function ShareScreen({ tenant, token }: { tenant: string; token: string }) {
  const qc = useQueryClient();
  const base = `/api/share/${tenant}/${token}`;
  const key = ['share', tenant, token];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<View>(base, { auth: false }),
    retry: false,
  });
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [response, setResponse] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<View>, done: string) => {
    setError(null);
    setBusy(true);
    try {
      qc.setQueryData(key, await f());
      toast.success(done);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="min-h-dvh bg-canvas px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-accent font-bold text-accent-fg">
            A
          </div>
          <p className="text-sm text-fg-muted">Documents sent to you through Aerolith Core</p>
        </header>
        {q.isPending ? (
          <Spinner label="Opening" />
        ) : q.isError ? (
          <Alert tone="danger">{describeError(q.error)}</Alert>
        ) : (
          <>
            <Card title={`${q.data.number}: ${q.data.subject}`}>
              <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="share-head">
                <div>
                  <dt className="text-xs text-fg-muted">Project</dt>
                  <dd>{q.data.project}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-muted">To</dt>
                  <dd>{q.data.recipient}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-muted">Purpose</dt>
                  <dd>{PURPOSE[q.data.purpose]}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-muted">Issued</dt>
                  <dd>
                    {q.data.issuedOn}
                    {q.data.dueOn && ` · response due ${q.data.dueOn}`}
                  </dd>
                </div>
              </dl>
              {q.data.notes && <p className="mt-2 whitespace-pre-wrap text-sm">{q.data.notes}</p>}
              <p className="mt-2 text-xs text-fg-muted">
                This link works until {new Date(q.data.expiresAt).toLocaleString(numberLocale())}.
              </p>
            </Card>
            {error && <Alert tone="danger">{error}</Alert>}
            <Card title="Documents">
              <ul className="space-y-1 text-sm">
                {q.data.items.map((it) => (
                  <li key={it.id} className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={async () => {
                        setError(null);
                        try {
                          const f = await api.download(`${base}/items/${it.id}`);
                          saveFile(f.blob, f.fileName);
                        } catch (err) {
                          setError(describeError(err));
                        }
                      }}
                    >
                      {it.name}
                    </Button>
                    <span className="text-fg-muted">
                      version {it.versionNo} · {it.copies} {it.copies === 1 ? 'copy' : 'copies'}
                      {it.remark && ` · ${it.remark}`}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Your reply">
              {q.data.acknowledgedAt && (
                <p className="text-sm" data-testid="share-acknowledged">
                  <Badge tone="success">Received</Badge> acknowledged by {q.data.acknowledgedBy}
                </p>
              )}
              {q.data.respondedAt ? (
                <p className="mt-2 text-sm" data-testid="share-responded">
                  <Badge tone="success">Answered</Badge> by {q.data.respondedBy}
                  {q.data.responseCode && ` with code ${q.data.responseCode}`}: {q.data.response}
                </p>
              ) : (
                <div className="mt-2 space-y-3">
                  <Field label="Your name">
                    <Input value={name} onChange={(e) => setName(e.target.value)} />
                  </Field>
                  {!q.data.acknowledgedAt && (
                    <Button
                      type="button"
                      busy={busy}
                      disabled={name.trim().length < 2}
                      onClick={() =>
                        void run(
                          () =>
                            api.request<View>(`${base}/acknowledge`, {
                              method: 'POST',
                              body: { name },
                              auth: false,
                            }),
                          'Receipt acknowledged',
                        )
                      }
                    >
                      Acknowledge receipt
                    </Button>
                  )}
                  {q.data.purpose === 'review' && (
                    <form
                      aria-label="Respond"
                      className="space-y-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = new FormData();
                        // The fields before the file: the server reads them in order.
                        form.append('name', name);
                        form.append('response', response);
                        form.append('code', code);
                        if (file) form.append('file', file, file.name);
                        void run(
                          () =>
                            api.request<View>(`${base}/respond`, {
                              method: 'POST',
                              body: form,
                              auth: false,
                            }),
                          'Response sent',
                        );
                      }}
                    >
                      <Field label="Code">
                        <Select value={code} onChange={(e) => setCode(e.target.value)}>
                          <option value="">No code</option>
                          {q.data.codes.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code}: {c.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Response">
                        <Textarea
                          value={response}
                          onChange={(e) => setResponse(e.target.value)}
                          rows={4}
                          required
                        />
                      </Field>
                      <Field label="Attach a file (optional)">
                        <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                      </Field>
                      <Button type="submit" busy={busy} disabled={name.trim().length < 2}>
                        Send the response
                      </Button>
                    </form>
                  )}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
