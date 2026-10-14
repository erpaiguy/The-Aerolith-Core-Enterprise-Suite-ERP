// The project a screen opens on (docs/wave7-plan.md step 7a.4): `?project=<id>` in the address, as the project
// workspace in the menu and the registers link to screens that pick a project themselves. The screen still lets the
// person choose another; a new `?project=` (the workspace's picker) switches it.
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

export function useProjectParam(fallback = ''): [string, (id: string) => void] {
  const fromUrl = useRouterState({
    select: (r) => {
      const v = (r.location.search as { project?: unknown }).project;
      return typeof v === 'string' && v ? v : undefined;
    },
  });
  const [value, setValue] = useState(fromUrl ?? fallback);
  useEffect(() => {
    if (fromUrl) setValue(fromUrl);
  }, [fromUrl]);
  return [value, setValue];
}
