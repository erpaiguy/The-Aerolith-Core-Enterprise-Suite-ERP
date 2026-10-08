import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from './format';

/**
 * Runs a write, shows its error or success message, and refreshes the listed queries afterwards.
 * `run` never throws; read `error` / `done` to show the outcome.
 */
export function useAction<T, A extends unknown[]>(
  fn: (...args: A) => Promise<T>,
  opts: { invalidate?: QueryKey[]; success?: (result: T) => string | null } = {},
) {
  const qc = useQueryClient();
  const [done, setDone] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: async (result) => {
      setDone(opts.success?.(result) ?? null);
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
    },
    onMutate: () => setDone(null),
  });
  return {
    run: (...args: A) => m.mutateAsync(args).catch(() => undefined),
    busy: m.isPending,
    error: m.error ? errorMessage(m.error) : null,
    rawError: m.error,
    done,
    result: m.data,
    reset: () => {
      m.reset();
      setDone(null);
    },
  };
}
