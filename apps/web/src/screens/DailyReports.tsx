// A project's daily site reports (docs/wave2b-plan.md step 7): today's report for each site, the days with none, the
// reports, and the weekly figures: man-days by trade, equipment hours worked and idle, hindrances by cause.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Select,
  Spinner,
  Table,
} from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { ChartFigure } from '../charts/ChartFigure';
import type { ChartOption } from '../charts/EChart';
import { valueAxis, type Measure } from '../charts/measure';
import { useT } from '../i18n/i18n';
import { describeError } from '../lib/format';
import {
  ACCOUNT,
  CAUSE,
  DSR_STATUS,
  DSR_TONE,
  indiaToday,
  type Account,
  type Cause,
  type DailyReport,
  type DailyReportList,
} from '../project/daily';
import { shortDate } from '../schedule/model';

interface Summary {
  manpower: { week: string; trade: string; manDays: number }[];
  equipment: { week: string; name: string; worked: string; idle: string }[];
  hindrances: { cause: Cause; account: Account; hours: string; days: number }[];
}

const weeksAgo = (n: number) => {
  const d = new Date(`${indiaToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n * 7);
  return d.toISOString().slice(0, 10);
};

/** Opens the site's report for the day, making it if there is none yet. */
export function useOpenReport(projectId: string) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = async (siteId: string, reportDate: string) => {
    setBusy(`${siteId} ${reportDate}`);
    setError(null);
    try {
      let id: string;
      try {
        id = (
          await api.request<DailyReport>(`/api/tenant/projects/${projectId}/daily-reports`, {
            method: 'POST',
            body: { siteId, reportDate },
          })
        ).id;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'report_exists') id = String(err.body.id);
        else throw err;
      }
      await navigate({ to: '/daily-reports/$reportId', params: { reportId: id } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  return { open, busy, error };
}

export function DailyReportsScreen({
  projectId,
  siteId,
}: {
  projectId: string;
  siteId: string | undefined;
}) {
  const t = useT();
  const navigate = useNavigate();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const list = useQuery({
    queryKey: ['daily-reports', projectId, siteId ?? ''],
    queryFn: () =>
      api.request<DailyReportList>(
        `/api/tenant/projects/${projectId}/daily-reports${siteId ? `?siteId=${siteId}` : ''}`,
      ),
  });
  const [from, to] = [weeksAgo(8), indiaToday()];
  const summary = useQuery({
    queryKey: ['daily-reports-summary', projectId, from, to],
    queryFn: () =>
      api.request<Summary>(
        `/api/tenant/projects/${projectId}/daily-reports/summary?from=${from}&to=${to}`,
      ),
  });
  const { open, busy, error } = useOpenReport(projectId);
  const sites = project.data?.sites.filter((s) => s.active) ?? [];
  if (list.isPending) return <Spinner />;
  if (list.isError) return <Alert tone="danger">{describeError(list.error)}</Alert>;
  const d = list.data;
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />{' '}
        {project.data ? `${project.data.number} · ${project.data.name}` : t('Project')}
      </Link>
      <h1 className="text-xl font-semibold">{t('Daily site reports')}</h1>
      {error && <Alert tone="danger">{error}</Alert>}
      {d.mayWrite && sites.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {sites.map((s) => (
            <Button
              key={s.id}
              busy={busy === `${s.id} ${indiaToday()}`}
              onClick={() => void open(s.id, indiaToday())}
            >
              <Plus className="size-4" aria-hidden /> {t('Today at {site}', { site: s.name })}
            </Button>
          ))}
        </div>
      )}
      <Missing list={d} mayWrite={d.mayWrite} open={open} />
      {sites.length > 1 && (
        <div className="w-56">
          <Field label={t('Site')}>
            <Select
              value={siteId ?? ''}
              onChange={(e) =>
                void navigate({
                  to: '/projects/$projectId/daily-reports',
                  params: { projectId },
                  search: { site: e.target.value || undefined },
                })
              }
            >
              <option value="">{t('All sites')}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      <Card title={t('Reports')}>
        <ReportTable rows={d.reports} />
      </Card>
      {summary.data && <Weekly s={summary.data} />}
    </div>
  );
}

export function Missing({
  list,
  mayWrite,
  open,
}: {
  list: DailyReportList;
  mayWrite: boolean;
  open: (siteId: string, date: string) => Promise<void>;
}) {
  const t = useT();
  if (!list.missing.length) return null;
  return (
    <Alert tone="warning">
      <span data-testid="missing-reports">
        {t('No submitted report:')}{' '}
        {list.missing.map((m, i) => (
          <span key={m.site.id}>
            {i > 0 && '; '}
            {m.site.name}{' '}
            {m.days.map((day, j) => (
              <span key={day}>
                {j > 0 && ', '}
                {mayWrite ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void open(m.site.id, day)}
                  >
                    {shortDate(day)}
                  </button>
                ) : (
                  shortDate(day)
                )}
              </span>
            ))}
          </span>
        ))}
      </span>
    </Alert>
  );
}

export function ReportTable({ rows }: { rows: DailyReportList['reports'] }) {
  const t = useT();
  if (!rows.length)
    return (
      <EmptyState title={t('None yet.')}>
        {t("Each site's report for the day is started from Today at the site.")}
      </EmptyState>
    );
  return (
    <Table minWidth="32rem">
      <thead>
        <tr>
          <th>{t('Day')}</th>
          <th>{t('Site')}</th>
          <th className="text-right">{t('Manpower')}</th>
          <th className="text-right">{t('Hindrance h')}</th>
          <th className="text-right">{t('Photos')}</th>
          <th>{t('Status')}</th>
        </tr>
      </thead>
      <tbody aria-label={t('Daily reports')}>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="whitespace-nowrap">
              <Link
                to="/daily-reports/$reportId"
                params={{ reportId: r.id }}
                className="text-accent hover:underline"
              >
                {shortDate(r.reportDate)}
              </Link>
            </td>
            <td>{r.site.name}</td>
            <td className="text-right tabular-nums">{r.headcount}</td>
            <td className="text-right tabular-nums">
              {Number(r.hindranceHours) > 0 ? Number(r.hindranceHours) : '-'}
            </td>
            <td className="text-right tabular-nums">{r.photos || '-'}</td>
            <td>
              <Badge tone={DSR_TONE[r.status]}>{t(DSR_STATUS[r.status])}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** The last eight weeks, from submitted reports. */
function Weekly({ s }: { s: Summary }) {
  const t = useT();
  const weeks = useMemo(
    () =>
      [...new Set([...s.manpower.map((m) => m.week), ...s.equipment.map((e) => e.week)])].sort(),
    [s],
  );
  const trades = [...new Set(s.manpower.map((m) => m.trade))];
  const manDays: Measure = { unit: t('man-days') };
  const hours: Measure = { unit: t('hours') };
  const manpower: ChartOption = {
    legend: { bottom: 0, type: 'scroll' },
    grid: { left: 48, right: 12, top: 32, bottom: 48 },
    xAxis: { type: 'category', data: weeks.map((w) => t('w/c {date}', { date: shortDate(w) })) },
    yAxis: valueAxis(manDays),
    series: trades.map((tr) => ({
      name: tr,
      type: 'bar',
      stack: 'm',
      data: weeks.map((w) => s.manpower.find((m) => m.week === w && m.trade === tr)?.manDays ?? 0),
    })),
  };
  const sum = (w: string, k: 'worked' | 'idle') =>
    s.equipment.filter((e) => e.week === w).reduce((x, e) => x + Number(e[k]), 0);
  const equipment: ChartOption = {
    legend: { bottom: 0 },
    grid: { left: 48, right: 12, top: 32, bottom: 48 },
    xAxis: { type: 'category', data: weeks.map((w) => t('w/c {date}', { date: shortDate(w) })) },
    yAxis: valueAxis(hours),
    series: [
      {
        name: t('Worked'),
        type: 'bar',
        stack: 'e',
        data: weeks.map((w) => sum(w, 'worked')),
      },
      {
        name: t('Idle'),
        type: 'bar',
        stack: 'e',
        data: weeks.map((w) => sum(w, 'idle')),
      },
    ],
  };
  if (!weeks.length && !s.hindrances.length) return null;
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t('Man-days by week')}>
          <ChartFigure
            title={t('Man-days by week')}
            label={t('Man-days by trade, by week')}
            heading={t('Week')}
            option={manpower}
            measures={manDays}
          />
        </Card>
        <Card title={t('Equipment hours by week')}>
          <ChartFigure
            title={t('Equipment hours by week')}
            label={t('Equipment hours worked and idle, by week')}
            heading={t('Week')}
            option={equipment}
            measures={hours}
          />
        </Card>
      </div>
      <Card title={t('Hindrances, last eight weeks')}>
        {s.hindrances.length === 0 ? (
          <EmptyState title={t('None recorded.')} />
        ) : (
          <Table minWidth="30rem">
            <thead>
              <tr>
                <th>{t('Cause')}</th>
                <th>{t('On whose account')}</th>
                <th className="text-right">{t('Hours')}</th>
                <th className="text-right">{t('Days')}</th>
              </tr>
            </thead>
            <tbody aria-label={t('Hindrances by cause')}>
              {s.hindrances.map((h) => (
                <tr key={`${h.cause}-${h.account}`}>
                  <td>{t(CAUSE[h.cause])}</td>
                  <td className="text-sm">{t(ACCOUNT[h.account])}</td>
                  <td className="text-right tabular-nums">{Number(h.hours)}</td>
                  <td className="text-right tabular-nums">{h.days}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
