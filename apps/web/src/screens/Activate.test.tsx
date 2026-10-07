import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../session/session', () => ({ useSession: () => ({ activate: vi.fn() }) }));

const { ActivateScreen } = await import('./Activate');

// A valid key: 19 characters plus its Luhn mod-32 check character.
const VALID = 'AERO-ABCDE-FGHJK-MNPQR-STVW';

describe('ActivateScreen', () => {
  it('confirms a well-formed key and flags a typo before contacting the server', async () => {
    const { luhnCheckChar } = await import('@aerolith/shared');
    const body = VALID.slice(5).replace(/-/g, '');
    const key = `${VALID}${luhnCheckChar(body)}`;
    render(<ActivateScreen />);
    const input = screen.getByRole('textbox', { name: /licence key/i });

    fireEvent.change(input, { target: { value: key.toLowerCase() } });
    expect(screen.getByText(/key format looks right/i)).toBeTruthy();

    const last = key.at(-1) === 'A' ? 'B' : 'A';
    fireEvent.change(input, { target: { value: key.slice(0, -1) + last } });
    expect(screen.getByRole('alert').textContent).toMatch(/typo/i);
  });
});
