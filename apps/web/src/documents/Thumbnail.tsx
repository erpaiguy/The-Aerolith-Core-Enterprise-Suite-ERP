// A document's thumbnail in a list, fetched with the user's session once the row is on screen.
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

export function Thumbnail({
  documentId,
  versionNo,
  has,
}: {
  documentId: string;
  versionNo: number;
  has: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || !has || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [has, seen]);
  const pic = useQuery({
    queryKey: ['document-thumbnail', documentId, versionNo],
    queryFn: async () => (await api.download(`/api/tenant/documents/${documentId}/thumbnail`)).blob,
    enabled: has && seen,
    staleTime: Infinity,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!pic.data) return;
    const u = URL.createObjectURL(pic.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [pic.data]);
  return (
    <span
      ref={box}
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-surface-2"
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="max-h-full max-w-full object-contain"
          data-testid="thumbnail"
        />
      ) : (
        <FileText className="size-4 text-fg-subtle" aria-hidden />
      )}
    </span>
  );
}
