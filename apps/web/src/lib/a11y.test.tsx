// Accessibility of the shared pieces (docs/wave9-plan.md step 9a.8): axe-core runs against the dialog, tabs, data grid,
// a labelled field and an empty state as they render, with the WCAG 2.1 A and AA rules the browser suite uses.
import { DataGrid, Dialog, EmptyState, Field, Input, Tabs, type GridColumn } from '@aerolith/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Inbox } from 'lucide-react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

// happy-dom does no layout, so the rules that measure the page (colour contrast, target size, scrolling regions) are
// left to the browser suite; contrast of the colour tokens is checked in contrast.test.ts.
const NO_LAYOUT = ['color-contrast', 'target-size', 'scrollable-region-focusable'];

async function violations(node: Element): Promise<string[]> {
  const result = await axe.run(node, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: Object.fromEntries(NO_LAYOUT.map((id) => [id, { enabled: false }])),
  });
  return result.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

interface Row {
  id: string;
  item: string;
  qty: number;
}
const rows: Row[] = [
  { id: '1', item: 'Cement', qty: 300 },
  { id: '2', item: 'Bricks', qty: 1200 },
];
const columns: GridColumn<Row>[] = [
  { id: 'item', header: 'Item', value: (r) => r.item, cell: (r) => r.item },
  { id: 'qty', header: 'Quantity', align: 'right', value: (r) => r.qty, cell: (r) => r.qty },
];

describe('shared components pass axe', () => {
  it('catches a control with no name (so a pass means something)', async () => {
    const { container } = render(
      <div>
        <input />
        <button type="button">
          <Inbox aria-hidden />
        </button>
      </div>,
    );
    const found = await violations(container);
    expect(found.some((v) => v.startsWith('label '))).toBe(true);
    expect(found.some((v) => v.startsWith('button-name '))).toBe(true);
  });

  it('dialog', async () => {
    const { baseElement } = render(
      <Dialog
        open
        onClose={() => {}}
        title="Delete this order?"
        description="It cannot be undone."
        footer={<button type="button">Delete</button>}
      >
        <p>The order and its lines go.</p>
      </Dialog>,
    );
    expect(await violations(baseElement)).toEqual([]);
  });

  it('tabs, with and without a panel', async () => {
    const tabs = [
      { id: 'lines', label: 'Lines', badge: 3 },
      { id: 'history', label: 'History' },
    ] as const;
    const { container } = render(
      <>
        <Tabs label="Order" tabs={[...tabs]} value="lines" onChange={() => {}}>
          <p>Three lines.</p>
        </Tabs>
        <Tabs label="Filter" tabs={[...tabs]} value="history" onChange={() => {}} />
      </>,
    );
    expect(await violations(container)).toEqual([]);
  });

  it('data grid, with its column menu', async () => {
    const { container } = render(
      <DataGrid
        id="a11y"
        label="Materials"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        exportName="materials"
      />,
    );
    expect(await violations(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    expect(screen.getByRole('group', { name: 'Columns and layout' })).toBeTruthy();
    expect(await violations(container)).toEqual([]);
  });

  it('a field with a hint and an error', async () => {
    const { container } = render(
      <form>
        <Field label="Quantity" hint="In the item's unit.">
          <Input type="number" />
        </Field>
        <Field label="Rate" error="Enter a rate above zero.">
          <Input />
        </Field>
      </form>,
    );
    expect(await violations(container)).toEqual([]);
  });

  it('empty state', async () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="No orders yet" action={<button type="button">New</button>}>
        Raise one from an approved requisition.
      </EmptyState>,
    );
    expect(await violations(container)).toEqual([]);
  });
});
