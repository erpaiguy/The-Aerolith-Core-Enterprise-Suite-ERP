// A project's daily site reports on its page (docs/wave2b-plan.md step 7): today's report for each site, the days
// without one, and the latest reports.
import { Alert, Button, Card, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';
import { Missing, ReportTable, useOpenReport } from '../screens/DailyReports';
import { indiaToday, type DailyReportList } from './daily';

export function ProjectDailyReports({ project: p }: { project: ProjectDetail }) {
  const list = useQuery({
    queryKey: ['daily-reports', p.id, ''],
    queryFn: () => api.request<DailyReportList>(`/api/tenant/projects/${p.id}/daily-reports`),
  });
  const { open, busy, error } = useOpenReport(p.id);
  const sites = p.sites.filter((s) => s.active);
  return (
    <Card
      title="Daily site reports"
      actions={
        <Link
          to="/projects/$projectId/daily-reports"
          params={{ projectId: p.id }}
          search={{ site: undefined }}
          className="text-sm text-accent hover:underline"
        >
          All reports and weekly figures
        </Link>
      }
    >
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{describeError(list.error)}</Alert>
      ) : (
        <div className="space-y-3">
          {list.data.mayWrite && (
            <div className="flex flex-wrap gap-2">
              {sites.length === 0 ? (
                <p className="text-sm text-fg-muted">Add a site to the project to report on it.</p>
              ) : (
                sites.map((s) => (
                  <Button
                    key={s.id}
                    variant="secondary"
                    busy={busy === `${s.id} ${indiaToday()}`}
                    onClick={() => void open(s.id, indiaToday())}
                  >
                    <Plus className="size-4" aria-hidden /> Today at {s.name}
                  </Button>
                ))
              )}
            </div>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <Missing list={list.data} mayWrite={list.data.mayWrite} open={open} />
          <ReportTable rows={list.data.reports.slice(0, 7)} />
        </div>
      )}
    </Card>
  );
}
