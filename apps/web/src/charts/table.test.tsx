// The table view of a chart (docs/wave9-plan.md step 9a.6): rows read from the chart's own series, figures in full,
// the CSV text, the summary for screen readers, and the Table toggle and drill-down on a chart.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartOption } from './EChart';
import { chartTable, summarise, toCsv } from './table';

const push = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history: { push } }) }));
// The canvas is ECharts' business; here it is a stand-in that reports its name and passes clicks on.
vi.mock('./EChart', () => ({
  EChart: ({ label, onClick }: { label: string; onClick?: (c: object) => void }) => (
    <div
      role="img"
      aria-label={label}
      onClick={() => onClick?.({ name: 'Bidding', dataIndex: 1 })}
    />
  ),
}));
const { ChartFigure, ChartTable } = await import('./ChartFigure');

afterEach(() => {
  cleanup();
  push.mockReset();
});

const stages: ChartOption = {
  xAxis: { type: 'category', data: ['Lead', 'Bidding', 'Submitted'] },
  yAxis: [{ type: 'value' }, { type: 'value' }],
  series: [
    { name: 'Tenders', type: 'bar', data: [2, 1, 0] },
    { name: 'Estimate', type: 'line', yAxisIndex: 1, data: [4250000, { value: 250000 }, null] },
  ],
};
const measures = { Tenders: { unit: 'tenders' }, Estimate: 'money' } as const;

describe('chartTable', () => {
  it('makes a row per category and a column per series', () => {
    const t = chartTable(stages, measures, 'Stage');
    expect(t.heading).toBe('Stage');
    expect(t.columns.map((c) => c.name)).toEqual(['Tenders', 'Estimate']);
    expect(t.rows).toEqual([
      { label: 'Lead', values: [2, 4250000] },
      { label: 'Bidding', values: [1, 250000] },
      { label: 'Submitted', values: [0, null] },
    ]);
  });
  it('reads a horizontal bar chart from its category axis, and a pie from its slices', () => {
    const bars = chartTable(
      {
        xAxis: { type: 'value' },
        yAxis: { type: 'category', data: ['A', 'B'] },
        series: [{ type: 'bar', data: [10, 20] }],
      },
      'money',
      'BOQ',
    );
    expect(bars.columns[0]!.name).toBe('Value');
    expect(bars.rows.map((r) => [r.label, r.values[0]])).toEqual([
      ['A', 10],
      ['B', 20],
    ]);
    const pie = chartTable(
      {
        series: [
          {
            name: 'Amount',
            type: 'pie',
            data: [
              { name: 'Material', value: 120000 },
              { name: 'Labour', value: 60000 },
            ],
          },
        ],
      },
      'money',
      'Part',
    );
    expect(pie.rows).toEqual([
      { label: 'Material', values: [120000] },
      { label: 'Labour', values: [60000] },
    ]);
  });
});

describe('toCsv', () => {
  it('writes plain numbers with units in the headings, blanks for no figure, and quotes where needed', () => {
    const t = chartTable(stages, measures, 'Stage');
    t.rows[0]!.label = 'Lead, "early"';
    expect(toCsv(t)).toBe(
      'Stage,Tenders (tenders),Estimate (₹)\r\n"Lead, ""early""",2,4250000\r\nBidding,1,250000\r\nSubmitted,0,\r\n',
    );
  });
});

describe('summarise', () => {
  it('says how many entries and the largest figure of each series, in full', () => {
    expect(summarise(chartTable(stages, measures, 'Stage'))).toBe(
      '3 entries. Tenders highest at Lead, 2 tenders; Estimate highest at Lead, ₹42,50,000.',
    );
  });
});

describe('ChartTable', () => {
  it('is a table captioned with the chart title, figures in full', () => {
    render(<ChartTable data={chartTable(stages, measures, 'Stage')} caption="Pipeline by stage" />);
    const table = screen.getByRole('table', { name: 'Pipeline by stage' });
    const rows = within(table).getAllByRole('row');
    expect(rows.map((r) => r.textContent)).toEqual([
      'StageTendersEstimate',
      'Lead2 tenders₹42,50,000',
      'Bidding1 tenders₹2,50,000',
      'Submitted0 tenders–',
    ]);
  });
});

describe('ChartFigure', () => {
  const figure = () =>
    render(
      <ChartFigure
        title="Pipeline by stage"
        label="Tenders by stage"
        heading="Stage"
        option={stages}
        measures={measures}
        drill={(c) => `/reports/pipeline?row=${c.dataIndex}`}
      />,
    );

  it('shows the chart with a summary, then the table on Table, whose labels drill', () => {
    figure();
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(
      /^Tenders by stage\. 3 entries\. Tenders highest at Lead/,
    );
    fireEvent.click(screen.getByRole('img'));
    expect(push).toHaveBeenLastCalledWith('/reports/pipeline?row=1');

    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByRole('button', { name: 'Table' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
    const link = screen.getByRole('link', { name: 'Submitted' });
    expect(link.getAttribute('href')).toBe('/reports/pipeline?row=2');
    fireEvent.click(link);
    expect(push).toHaveBeenLastCalledWith('/reports/pipeline?row=2');
  });

  it('downloads the table as CSV named after the chart', async () => {
    const urls: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      urls.push(b);
      return 'blob:x';
    });
    let name = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      name = this.download;
    });
    figure();
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(name).toBe('Pipeline by stage.csv');
    expect(await urls[0]!.text()).toContain(
      'Stage,Tenders (tenders),Estimate (₹)\r\nLead,2,4250000',
    );
    click.mockRestore();
  });
});
