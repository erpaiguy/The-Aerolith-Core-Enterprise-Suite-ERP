// The legal pages (docs/wave9-plan.md step 9b.3): each document readable by anyone, signed in or not, saying it is a
// draft until an admin marks its version reviewed by the company's lawyer; and, after signing in, the documents a
// person has not yet accepted at their current version, to read and accept before going on.
import { LEGAL_DOCUMENTS, legalDocument, type LegalKey } from '@aerolith/shared';
import { Alert, AuthLayout, Button, Spinner, toast } from '@aerolith/ui';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { describeError, formatDate } from '../lib/format';
import { useSession } from '../session/session';
import { LEGAL_TEXTS } from './texts';

export interface LegalState {
  documents: {
    key: LegalKey;
    title: string;
    version: string;
    acceptedBy: 'everyone' | 'admins';
    mustAccept: boolean;
    acceptedAt: string | null;
    reviewed: { by: string; at: string } | null;
  }[];
}

/** The person's acceptances and the review state; null when signed out. */
export function useLegalState() {
  const session = useSession();
  return useQuery({
    queryKey: ['legal'],
    queryFn: () => api.request<LegalState>('/api/tenant/legal'),
    enabled: session.status === 'signed_in',
    staleTime: 60_000,
  });
}

function DraftNotice({ reviewed }: { reviewed: { by: string; at: string } | null | undefined }) {
  if (reviewed)
    return (
      <p className="text-xs text-fg-muted">
        Reviewed for the company by {reviewed.by} on {formatDate(reviewed.at)}.
      </p>
    );
  return (
    <Alert tone="warning">
      This is a draft, written without a lawyer. It must be reviewed by the company’s lawyer before
      anyone relies on it; an administrator marks it reviewed in Settings. Words in [square
      brackets] are still to be filled in.
    </Alert>
  );
}

function Body({ k }: { k: LegalKey }) {
  const text = LEGAL_TEXTS[k];
  return (
    <div className="space-y-5 text-sm leading-relaxed">
      <p className="text-fg-muted">{text.summary}</p>
      {text.sections.map((s) => (
        <section key={s.heading} className="space-y-2">
          <h2 className="text-base font-semibold">{s.heading}</h2>
          {s.paragraphs.map((p) => (
            <p key={p.slice(0, 40)}>{p}</p>
          ))}
          {s.points && (
            <ul className="list-disc space-y-1 pl-5">
              {s.points.map((p) => (
                <li key={p.slice(0, 40)}>{p}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** One document, open to anyone: /legal/privacy-policy. */
export function LegalPage({ docKey }: { docKey: string }) {
  const doc = legalDocument(docKey);
  const state = useLegalState();
  const reviewed = state.data?.documents.find((d) => d.key === docKey)?.reviewed;
  if (!doc) return <Shell title="Not found">There is no such document.</Shell>;
  return (
    <Shell title={doc.title}>
      <p className="mb-3 text-xs text-fg-muted">Version of {formatDate(doc.version)}</p>
      <div className="mb-5">
        <DraftNotice reviewed={reviewed} />
      </div>
      <Body k={doc.key} />
      <nav
        aria-label="Other documents"
        className="mt-8 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-4 text-sm"
      >
        {LEGAL_DOCUMENTS.filter((d) => d.key !== doc.key).map((d) => (
          <Link
            key={d.key}
            to="/legal/$key"
            params={{ key: d.key }}
            className="text-accent underline"
          >
            {d.title}
          </Link>
        ))}
        <Link to="/licences" className="text-accent underline">
          Third-party licences
        </Link>
      </nav>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-canvas px-4 py-6 md:px-8">
      <div className="mx-auto max-w-3xl">
        <button
          type="button"
          onClick={() => history.back()}
          className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
        >
          <ArrowLeft className="size-4" aria-hidden /> Back
        </button>
        <h1 className="mb-1 text-xl font-semibold">{title}</h1>
        <article className="rounded-lg border border-line bg-surface p-5 md:p-8">
          {children}
        </article>
      </div>
    </main>
  );
}

/**
 * Before carrying on after signing in: the documents this person has not accepted at their current version. Each one
 * can be read in full here; one tick per document; then accept, or sign out.
 */
export function AcceptLegalScreen({ pending }: { pending: LegalState['documents'] }) {
  const session = useSession();
  const qc = useQueryClient();
  const [ticked, setTicked] = useState<Set<LegalKey>>(new Set());
  const [open, setOpen] = useState<LegalKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = pending.every((d) => ticked.has(d.key));
  return (
    <AuthLayout
      title="Before you start"
      subtitle="Please read and accept these. You are asked again only when one of them changes."
    >
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const next = await api.request<LegalState>('/api/tenant/legal/accept', {
              method: 'POST',
              body: { documents: pending.map((d) => d.key) },
            });
            qc.setQueryData(['legal'], next);
            toast.success('Thank you', 'Your acceptance is recorded with the date and time.');
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <ul className="space-y-3">
          {pending.map((d) => (
            <li key={d.key} className="rounded-md border border-line p-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={ticked.has(d.key)}
                  onChange={(e) => {
                    const next = new Set(ticked);
                    if (e.target.checked) next.add(d.key);
                    else next.delete(d.key);
                    setTicked(next);
                  }}
                />
                <span>
                  I have read and accept the <strong>{d.title}</strong>
                  {d.acceptedBy === 'admins' ? ' on behalf of the company' : ''} (version of{' '}
                  {formatDate(d.version)}).
                </span>
              </label>
              <button
                type="button"
                className="mt-1 ml-6 text-xs text-accent underline"
                aria-expanded={open === d.key}
                onClick={() => setOpen(open === d.key ? null : d.key)}
              >
                {open === d.key ? 'Hide' : 'Read'} the {d.title.toLowerCase()}
              </button>
              {open === d.key && (
                <div className="mt-3 max-h-80 space-y-3 overflow-y-auto rounded-md bg-surface-2 p-3">
                  <DraftNotice reviewed={d.reviewed} />
                  <Body k={d.key} />
                </div>
              )}
            </li>
          ))}
        </ul>
        <Button type="submit" className="w-full" disabled={!all} busy={busy}>
          Accept and continue
        </Button>
        <button
          type="button"
          className="w-full text-center text-sm text-fg-muted underline"
          onClick={() => void session.signOut()}
        >
          Sign out instead
        </button>
      </form>
    </AuthLayout>
  );
}

/** Wraps the signed-in app: shows the acceptance screen while anything is pending. */
export function LegalGate({ children }: { children: ReactNode }) {
  const state = useLegalState();
  if (state.isPending) return <Spinner label="Starting" />;
  // Offline or the server cannot say: carry on; the question is asked next time.
  const pending = state.data?.documents.filter((d) => d.mustAccept) ?? [];
  return pending.length ? <AcceptLegalScreen pending={pending} /> : <>{children}</>;
}
