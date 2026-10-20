// Before an idle session ends (docs/wave9-plan.md step 9a.3): a warning with the time left, staying resets it, and at
// the end the app signs out itself and says why.
import { cleanup, act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn(async () => undefined);
vi.mock('./session', () => ({ useSession: () => ({ status: 'signed_in', signOut }) }));
vi.mock('../api/client', () => ({ api: { refresh: vi.fn(async () => null) } }));

const { IdleGuard } = await import('./IdleGuard');

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  signOut.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the idle guard', () => {
  it('warns before the end, and staying starts the clock again', () => {
    render(<IdleGuard idleMs={60_000} warnMs={10_000} />);
    act(() => vi.advanceTimersByTime(45_000));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByRole('alertdialog').textContent).toMatch(/signed out in 0:0\d/);
    fireEvent.click(screen.getByText('Stay signed in'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => vi.advanceTimersByTime(45_000));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('counts a key press as activity', () => {
    render(<IdleGuard idleMs={60_000} warnMs={10_000} />);
    act(() => vi.advanceTimersByTime(40_000));
    fireEvent.keyDown(window, { key: 'a' });
    act(() => vi.advanceTimersByTime(40_000));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('signs out at the end and says it was for want of activity', () => {
    render(<IdleGuard idleMs={60_000} warnMs={10_000} />);
    act(() => vi.advanceTimersByTime(61_000));
    expect(signOut).toHaveBeenCalledWith('idle');
  });
});
