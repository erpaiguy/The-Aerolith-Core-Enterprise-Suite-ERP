// Third-party licences (docs/licensing-policy.md §3.2): the notices file built with the app (tools/notices.mjs),
// shown as it is. Open to anyone, signed in or not.
import { Alert, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';

export function LicencesScreen() {
  const q = useQuery({
    queryKey: ['third-party-notices'],
    queryFn: async () => {
      const res = await fetch('/THIRD_PARTY_NOTICES.txt');
      const text = await res.text();
      // A development server answers unknown files with the app's index page.
      if (!res.ok || text.trimStart().startsWith('<')) throw new Error('not built');
      return text;
    },
    staleTime: Infinity,
  });
  return (
    <div className="min-h-dvh bg-canvas px-4 py-6 md:px-8">
      <button
        type="button"
        onClick={() => history.back()}
        className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Back
      </button>
      <h1 className="text-xl font-semibold">Third-party licences</h1>
      <p className="mt-1 max-w-3xl text-sm text-fg-muted">
        Aerolith Core is built with the open-source software below. Each is used unmodified under
        the licence shown, whose text and notices are reproduced in full. The same list is available
        as a CycloneDX SBOM at{' '}
        <a href="/sbom.cdx.json" className="underline" download>
          sbom.cdx.json
        </a>
        .
      </p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <div className="mt-4 max-w-xl">
          <Alert tone="warning">
            The licence list is generated when the app is built; this copy was not built with it.
          </Alert>
        </div>
      ) : (
        <pre
          className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-4 text-xs leading-relaxed"
          aria-label="Third-party licences"
        >
          {q.data}
        </pre>
      )}
    </div>
  );
}
