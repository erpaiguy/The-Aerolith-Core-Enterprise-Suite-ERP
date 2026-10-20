// The new-release notice (docs/wave9-plan.md step 9b.4): nothing when this is the latest; the version and its notes
// when one is out; "Required" when this version is below the minimum; "Restart and update" in the desktop app once the
// update is downloaded.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const status = vi.fn();
vi.mock('../api/client', () => ({ api: { request: () => status() } }));
const { ReleaseNotice } = await import('./Updates');

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReleaseNotice place="status" />
    </QueryClientProvider>,
  );
const latest = { version: '1.1.0', date: '2026-11-01', notes: ['Grids remember your columns.'] };

afterEach(() => {
  cleanup();
  delete window.aerolithDesktop;
});

describe('the new-release notice', () => {
  it('shows nothing when this is the latest', async () => {
    status.mockResolvedValue({ available: false, required: false, latest });
    show();
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('names the version, marks it required, and opens the notes', async () => {
    status.mockResolvedValue({ available: true, required: true, latest });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Version 1.1.0 is available/ }));
    expect(screen.getByText('Required')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toContain('Grids remember your columns.');
  });

  it('in the desktop app, offers to restart once the update is ready', async () => {
    status.mockResolvedValue({ available: true, required: false, latest });
    const restart = vi.fn(async () => undefined);
    window.aerolithDesktop = {
      apiBaseUrl: '',
      platform: 'windows',
      appVersion: '1.0.0',
      deviceId: async () => 'x',
      getRefreshToken: async () => null,
      setRefreshToken: async () => undefined,
      updates: {
        get: async () => ({
          mode: 'auto',
          ready: { version: '1.1.0', notes: ['Faster.'], required: false },
        }),
        check: async () => null,
        setMode: async () => undefined,
        restart,
        onChange: () => () => undefined,
      },
    };
    show();
    fireEvent.click(await screen.findByRole('button', { name: /ready to install/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart and update' }));
    expect(restart).toHaveBeenCalled();
  });
});
