// What the signed-in user may change (admin-configurable per role; the server enforces it on every write).
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useSession } from './session';

export type Permission =
  | 'tender.edit'
  | 'boq.edit'
  | 'rates.edit'
  | 'pricing.edit'
  | 'rfq.edit'
  | 'documents.edit'
  | 'programme.edit'
  | 'projects.edit'
  | 'projects.all'
  | 'costcodes.edit'
  | 'purchase.edit'
  | 'stores.receive'
  | 'stores.manage'
  | 'accounts.view'
  | 'accounts.post'
  | 'dsr.acknowledge';

export function usePermission(p: Permission): boolean {
  const { user, licence } = useSession();
  const mine = useQuery({
    queryKey: ['my-permissions', user?.id],
    queryFn: () => api.request<Permission[]>('/api/tenant/permissions/mine'),
    enabled: Boolean(user) && user?.role !== 'admin',
    staleTime: 30_000,
  });
  if (!user || licence?.featuresUnlocked === false) return false;
  return user.role === 'admin' || (mine.data?.includes(p) ?? false);
}
