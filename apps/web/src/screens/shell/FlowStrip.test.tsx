// Process flows (docs/wave9-plan.md step 9a.7): the strip's markup and the stages worked out on the page.
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const { FlowStrip } = await import('./FlowStrip');
const { bookingSteps, clientBillSteps, stepStates } = await import('./flows');

afterEach(cleanup);

describe('stepStates', () => {
  it('marks complete stages done, the first one waiting as current and the rest not yet', () => {
    expect(
      stepStates([
        { applies: false, complete: false },
        { applies: true, complete: true },
        { applies: true, complete: false },
        { applies: true, complete: false },
        { applies: true, complete: true },
      ]),
    ).toEqual(['na', 'done', 'current', 'todo', 'done']);
  });
});

describe('FlowStrip', () => {
  it('is an ordered list with the current stage marked, states in words, and links to the others', () => {
    render(
      <FlowStrip
        steps={[
          { key: 'requisition', label: 'Requisition', state: 'na', docs: [] },
          {
            key: 'order',
            label: 'Order',
            state: 'done',
            here: true,
            docs: [{ id: 'o1', number: 'PO/2026-27/0001', href: '/orders/o1', here: true }],
          },
          {
            key: 'receipt',
            label: 'Goods receipt',
            state: 'current',
            count: '{n} receipts',
            docs: [
              { id: 'g1', number: 'GRN/2026-27/0001', href: '/receipts/g1' },
              { id: 'g2', number: 'GRN/2026-27/0002', href: '/receipts/g2' },
            ],
          },
          { key: 'bill', label: 'Supplier bill', state: 'todo', docs: [], hidden: 1 },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Where this stands' });
    expect(list.tagName).toBe('OL');
    const items = within(list)
      .getAllByRole('listitem')
      .filter((li) => li.parentElement === list);
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(items[0]!.textContent).toContain('Does not apply');
    expect(items[1]!.textContent).toContain('Done · this page');
    expect(items[2]!.textContent).toContain('Now · 2 receipts');
    expect(items[3]!.textContent).toContain('Not yet');
    expect(items[3]!.textContent).toContain('1 you cannot open');
    // The page's own document is not a link to itself; the others are.
    expect(within(items[1]!).queryByRole('link')).toBeNull();
    expect(
      within(items[2]!)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/receipts/g1', '/receipts/g2']);
  });
});

describe('the stages worked out on the page', () => {
  const bill = {
    id: 'b1',
    raNo: 2,
    project: { id: 'p1' },
    certified: null,
    receipts: [] as { id: string; receivedOn: string; amount: string; voucher: string }[],
  };
  it('follows an RA bill from submitted to paid', () => {
    const states = (b: Parameters<typeof clientBillSteps>[0]) =>
      clientBillSteps(b).map((s) => s.state);
    expect(states({ ...bill, status: 'draft' })).toEqual(['done', 'current', 'todo', 'todo']);
    expect(states({ ...bill, status: 'submitted' })).toEqual(['done', 'done', 'current', 'todo']);
    const certified = { ...bill, status: 'certified' as const, certified: { net: '1000.00' } };
    expect(
      states({
        ...certified,
        receipts: [{ id: 'r1', receivedOn: '2026-10-01', amount: '400.00', voucher: 'RV/1' }],
      }),
    ).toEqual(['done', 'done', 'done', 'current']);
    const paid = clientBillSteps({
      ...certified,
      receipts: [
        { id: 'r1', receivedOn: '2026-10-01', amount: '400.00', voucher: 'RV/1' },
        { id: 'r2', receivedOn: '2026-10-09', amount: '600.00', voucher: 'RV/2' },
      ],
    });
    expect(paid.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(paid[3]!.docs.map((d) => d.href)).toEqual([
      '/accounts/client-receipts/r1',
      '/accounts/client-receipts/r2',
    ]);
    expect(states({ ...bill, status: 'cancelled' })).toEqual(['done', 'na', 'na', 'na']);
  });

  it('follows a booking to possession', () => {
    const b = {
      id: 'k1',
      number: 'BK-001',
      status: 'booked',
      bookedOn: '2026-09-01',
      agreementOn: null as string | null,
      demands: [{ id: 'd1', number: 'DM-001' }],
      totals: { outstanding: '100000.00' },
      cancelledOn: null as string | null,
      possessionOfferedOn: null as string | null,
      possessionOn: null as string | null,
    };
    const states = (x: typeof b) => bookingSteps(x).map((s) => s.state);
    expect(states(b)).toEqual(['done', 'current', 'todo', 'todo']);
    const agreed = { ...b, status: 'agreement', agreementOn: '2026-09-20' };
    expect(states(agreed)).toEqual(['done', 'done', 'current', 'todo']);
    expect(
      states({
        ...agreed,
        possessionOfferedOn: '2027-03-01',
        possessionOn: '2027-03-15',
        totals: { outstanding: '0.00' },
      }),
    ).toEqual(['done', 'done', 'done', 'done']);
    expect(states({ ...b, status: 'cancelled', cancelledOn: '2026-09-10' })).toEqual([
      'done',
      'na',
      'na',
      'na',
    ]);
    expect(bookingSteps(b)[2]!.docs[0]!.href).toBe('/print/demands/k1/d1');
  });
});
