// The Help panel and the Help centre on the page (docs/wave9-plan.md step 9b.2): the current page's help, the search
// with arrow keys and Enter, and the support form's diagnostics with a request reference.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => () => undefined,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: '/orders', href: '/orders', search: {} } }),
}));
vi.mock('../accounts/model', () => ({
  useCompanies: () => ({ data: { companies: [{ id: 'c1', isDefault: true }] } }),
}));
vi.mock('../print/Letterhead', () => ({
  useLetterhead: () => ({ data: { email: 'office@shegaon.in' } }),
}));

const { HelpPanel } = await import('./HelpPanel');
const { HelpCentreScreen } = await import('./HelpCentre');
const { clearRecentRequests, recordRequest } = await import('../api/client');

afterEach(() => {
  cleanup();
  clearRecentRequests();
});

describe('HelpPanel', () => {
  it('shows the help of the current page', () => {
    render(<HelpPanel onClose={() => undefined} />);
    const article = screen.getByRole('article', { name: 'Help: Orders' });
    expect(within(article).getByRole('heading', { name: 'Orders' })).toBeTruthy();
    expect(within(article).getByRole('button', { name: 'Goods receipts' })).toBeTruthy();
  });

  it('searches, moves through the results with the arrow keys and opens one with Enter', () => {
    render(<HelpPanel onClose={() => undefined} />);
    const box = screen.getByLabelText('Search help');
    fireEvent.change(box, { target: { value: 'receipt' } });
    const results = within(screen.getByRole('list', { name: 'Help topics found' })).getAllByRole(
      'button',
    );
    expect(results.length).toBeGreaterThan(1);
    expect(results[0]!.getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    const second = results[1]!.textContent!;
    fireEvent.keyDown(box, { key: 'Enter' });
    const shown = screen.getByRole('article');
    expect(second.startsWith(shown.getAttribute('aria-label')!.replace('Help: ', ''))).toBe(true);
    expect(screen.getByRole('button', { name: 'Back to help for this page' })).toBeTruthy();
  });
});

describe('HelpCentreScreen', () => {
  it('lists the keyboard shortcuts', () => {
    render(<HelpCentreScreen section="shortcuts" />);
    expect(screen.getByText('Ctrl+K')).toBeTruthy();
    expect(screen.getAllByText('F1').length).toBeGreaterThan(0);
  });

  it('shows the support request’s diagnostics with the last request’s reference', () => {
    recordRequest({
      at: '2026-10-20T05:29:58.000Z',
      method: 'GET',
      path: '/api/tenant/orders',
      status: 200,
      ref: 'K7P2QX9M4A',
    });
    render(<HelpCentreScreen section="support" from="/orders" />);
    const block = screen.getByLabelText('Diagnostics').textContent!;
    expect(block).toContain('Page: /orders (Orders)');
    expect(block).toContain('GET /api/tenant/orders 200 ref K7P2QX9M4A');
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'No orders' } });
    const mail = screen.getByRole('link', { name: 'Email to support' }).getAttribute('href')!;
    expect(mail.startsWith('mailto:office@shegaon.in?subject=No%20orders&body=')).toBe(true);
    expect(decodeURIComponent(mail)).toContain('ref K7P2QX9M4A');
  });
});
