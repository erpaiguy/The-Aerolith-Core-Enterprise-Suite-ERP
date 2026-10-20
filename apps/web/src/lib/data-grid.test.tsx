// The data grid (docs/wave9-plan.md step 9a.5): hiding, ordering, freezing, density, sort and saved views all go
// through the grid's storage and come back after a remount; the Excel export is a valid ZIP (headers, central
// directory, CRC-32) whose sheet holds the visible columns in the shown order and sort.
import {
  DataGrid,
  crc32,
  xlsxBytes,
  type GridColumn,
  type GridState,
  type GridStorage,
} from '@aerolith/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  name: string;
  amount: number;
  on: Date;
}
const rows: Row[] = [
  { id: '1', name: 'Cement', amount: 300, on: new Date(2026, 0, 5) },
  { id: '2', name: 'Bricks', amount: 1200, on: new Date(2026, 1, 1) },
  { id: '3', name: 'Aggregate', amount: 50, on: new Date(2025, 11, 31) },
];
const columns: GridColumn<Row>[] = [
  { id: 'name', header: 'Item', value: (r) => r.name, cell: (r) => r.name, hideable: false },
  {
    id: 'amount',
    header: 'Amount',
    align: 'right',
    value: (r) => r.amount,
    cell: (r) => `₹${r.amount}`,
  },
  { id: 'on', header: 'Date', value: (r) => r.on, cell: (r) => r.on.toDateString() },
];

/** A storage that behaves like the per-person setting: one value, kept across mounts. */
function makeStore() {
  const box: { value: GridState | null } = { value: null };
  function Grid() {
    const [, bump] = useState(0);
    const storage: GridStorage = {
      get: () => box.value ?? undefined,
      set: (s) => {
        box.value = s;
        bump((n) => n + 1);
      },
    };
    return (
      <DataGrid
        id="test"
        label="Things"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        storage={storage}
        exportName="things"
      />
    );
  }
  return { box, Grid };
}

const headers = () =>
  within(screen.getByRole('table', { name: 'Things' }))
    .getAllByRole('columnheader')
    .map((h) => h.textContent);
const firstCells = () =>
  within(screen.getByRole('rowgroup', { name: 'Things' }))
    .getAllByRole('row')
    .map((r) => within(r).getAllByRole('cell')[0]!.textContent);
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
const remount = (Grid: () => React.JSX.Element) => {
  cleanup();
  render(<Grid />);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('data grid layout', () => {
  it('hides a column and keeps it hidden', () => {
    const { box, Grid } = makeStore();
    render(<Grid />);
    openMenu();
    expect((screen.getByRole('checkbox', { name: 'Item' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Amount' }));
    expect(headers()).toEqual(['Item', 'Date']);
    expect(box.value?.hidden).toEqual(['amount']);
    remount(Grid);
    expect(headers()).toEqual(['Item', 'Date']);
  });

  it('reorders columns with the move buttons and keeps focus on the button', () => {
    const { box, Grid } = makeStore();
    render(<Grid />);
    openMenu();
    const down = screen.getByRole('button', { name: 'Move Item down' });
    expect(
      (screen.getByRole('button', { name: 'Move Item up' }) as HTMLInputElement).disabled,
    ).toBe(true);
    down.focus();
    fireEvent.click(down);
    expect(headers()).toEqual(['Amount', 'Item', 'Date']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Item down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Date up' }));
    expect(headers()).toEqual(['Amount', 'Date', 'Item']);
    expect(box.value?.order).toEqual(['amount', 'on', 'name']);
    remount(Grid);
    expect(headers()).toEqual(['Amount', 'Date', 'Item']);
  });

  it('freezes the first columns and switches density', () => {
    const { box, Grid } = makeStore();
    render(<Grid />);
    openMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Freeze columns' }), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(box.value).toMatchObject({ frozen: 2, density: 'compact' });
    remount(Grid);
    const table = screen.getByRole('table', { name: 'Things' });
    expect(table.dataset.density).toBe('compact');
    const ths = within(table).getAllByRole('columnheader');
    expect(ths[0]!.style.position).toBe('sticky');
    expect(ths[1]!.style.position).toBe('sticky');
    expect(ths[1]!.style.left).toBe('160px');
    expect(ths[2]!.style.position).toBe('');
  });

  it('sorts by a header, with aria-sort, and keeps it', () => {
    const { box, Grid } = makeStore();
    render(<Grid />);
    const amount = () => screen.getByRole('columnheader', { name: /Amount/ });
    expect(amount().getAttribute('aria-sort')).toBe('none');
    fireEvent.click(within(amount()).getByRole('button'));
    expect(amount().getAttribute('aria-sort')).toBe('ascending');
    expect(firstCells()).toEqual(['Aggregate', 'Cement', 'Bricks']);
    fireEvent.click(within(amount()).getByRole('button'));
    expect(amount().getAttribute('aria-sort')).toBe('descending');
    expect(firstCells()).toEqual(['Bricks', 'Cement', 'Aggregate']);
    expect(box.value?.sort).toEqual({ id: 'amount', dir: 'desc' });
    remount(Grid);
    expect(firstCells()).toEqual(['Bricks', 'Cement', 'Aggregate']);
    fireEvent.click(within(amount()).getByRole('button'));
    expect(amount().getAttribute('aria-sort')).toBe('none');
    expect(firstCells()).toEqual(['Cement', 'Bricks', 'Aggregate']);
  });

  it('resizes a column with the arrow keys on its handle', () => {
    const { box, Grid } = makeStore();
    render(<Grid />);
    const handle = screen.getByRole('separator', { name: 'Resize Amount' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(box.value?.widths).toEqual({ amount: 220 });
    remount(Grid);
    expect(
      screen.getByRole('separator', { name: 'Resize Amount' }).getAttribute('aria-valuenow'),
    ).toBe('220');
  });

  it('saves, picks, deletes and resets views', () => {
    const { box, Grid } = makeStore();
    render(<Grid />);
    openMenu();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Date' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), {
      target: { value: 'Short' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(box.value?.views.map((v) => v.name)).toEqual(['Short']);
    // back to the default layout: the saved view stays
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(headers()).toEqual(['Item', 'Amount', 'Date']);
    expect(box.value?.views).toHaveLength(1);
    remount(Grid);
    fireEvent.change(screen.getByRole('combobox', { name: 'Saved view' }), {
      target: { value: 'Short' },
    });
    expect(headers()).toEqual(['Item', 'Amount']);
    expect(box.value?.view).toBe('Short');
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Delete view Short' }));
    expect(box.value?.views).toEqual([]);
    expect(screen.queryByRole('combobox', { name: 'Saved view' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(box.value).toBeNull();
  });

  it('shows the empty state when there are no rows', () => {
    render(
      <DataGrid
        id="none"
        label="Nothing"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<p>No things.</p>}
      />,
    );
    expect(screen.getByText('No things.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

// --- reading back the ZIP the grid writes ---
interface Entry {
  name: string;
  data: Uint8Array;
}
function unzip(bytes: Uint8Array): Entry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const end = bytes.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  const cdSize = v.getUint32(end + 12, true);
  let at = v.getUint32(end + 16, true);
  expect(at + cdSize).toBe(end);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    expect(v.getUint16(at + 10, true)).toBe(0); // stored
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 20, true);
    expect(v.getUint32(at + 24, true)).toBe(size);
    const nameLen = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true);
    const comment = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    // the local header agrees with the central directory
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    expect(v.getUint32(local + 14, true)).toBe(crc);
    expect(v.getUint32(local + 18, true)).toBe(size);
    const lName = v.getUint16(local + 26, true);
    const lExtra = v.getUint16(local + 28, true);
    expect(dec.decode(bytes.subarray(local + 30, local + 30 + lName))).toBe(name);
    const start = local + 30 + lName + lExtra;
    const data = bytes.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

describe('excel export', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes the six workbook parts with numbers, dates and escaped text', () => {
    const files = unzip(
      xlsxBytes([
        ['Item', 'Amount', 'Date'],
        ['A & B <x>', 12.5, new Date(2026, 0, 1)],
      ]),
    );
    expect(files.map((f) => f.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
      'xl/styles.xml',
    ]);
    const sheet = new TextDecoder().decode(files[4]!.data);
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t>Item</t></is></c>');
    expect(sheet).toContain('<t>A &amp; B &lt;x&gt;</t>');
    expect(sheet).toContain('<c r="B2"><v>12.5</v></c>');
    // 1 January 2026 is day 46023 in Excel's calendar
    expect(sheet).toContain('<c r="C2" s="2"><v>46023</v></c>');
  });

  it('exports the visible columns in the shown order and sort', async () => {
    let blob: Blob | null = null;
    let fileName = '';
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blob = b as Blob;
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      fileName = this.download;
    });
    const { Grid } = makeStore();
    render(<Grid />);
    openMenu();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Date' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Amount up' }));
    fireEvent.click(within(screen.getByRole('columnheader', { name: /Item/ })).getByRole('button'));
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Export to Excel' }));
    });
    expect(fileName).toBe('things.xlsx');
    expect(blob).not.toBeNull();
    const b = blob as unknown as Blob;
    expect(b.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const files = unzip(new Uint8Array(await b.arrayBuffer()));
    const sheet = new TextDecoder().decode(files.find((f) => f.name.endsWith('sheet1.xml'))!.data);
    const cells = [
      ...sheet.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:<is><t>([^<]*)<\/t><\/is>|<v>([^<]*)<\/v>)/g),
    ].map((m) => [m[1], m[2] ?? Number(m[3])]);
    expect(cells).toEqual([
      ['A1', 'Amount'],
      ['B1', 'Item'],
      ['A2', 50],
      ['B2', 'Aggregate'],
      ['A3', 1200],
      ['B3', 'Bricks'],
      ['A4', 300],
      ['B4', 'Cement'],
    ]);
  });
});
