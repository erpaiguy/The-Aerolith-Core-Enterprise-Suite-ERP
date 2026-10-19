// The shared feedback pieces (docs/wave9-plan.md step 9a.2): a confirmation answers with the button pressed, the
// gravest ones need the word typed, toasts appear and go, and a server fault shows its reference.
import {
  ConfirmProvider,
  ErrorDialogHost,
  Tabs,
  Toaster,
  currentToasts,
  dismissToast,
  toast,
  useConfirm,
  type ConfirmOptions,
} from '@aerolith/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';

function Asker({
  options,
  onAnswer,
}: {
  options: ConfirmOptions;
  onAnswer: (ok: boolean) => void;
}) {
  const confirm = useConfirm();
  return (
    <button type="button" onClick={() => void confirm(options).then(onAnswer)}>
      Ask
    </button>
  );
}

const ask = async (options: ConfirmOptions) => {
  const onAnswer = vi.fn();
  render(
    <ConfirmProvider>
      <Asker options={options} onAnswer={onAnswer} />
    </ConfirmProvider>,
  );
  fireEvent.click(screen.getByText('Ask'));
  return { onAnswer, dialog: await screen.findByRole('alertdialog') };
};

afterEach(() => {
  cleanup();
  for (const t of currentToasts()) dismissToast(t.id);
});

describe('confirmations', () => {
  it('answer yes with the confirm button and no with cancel', async () => {
    const yes = await ask({ title: 'Cancel B-12?', confirmLabel: 'Cancel the booking' });
    expect(yes.dialog.textContent).toContain('Cancel B-12?');
    await act(async () => fireEvent.click(screen.getByText('Cancel the booking')));
    expect(yes.onAnswer).toHaveBeenCalledWith(true);
  });

  it('cancel says no', async () => {
    const no = await ask({ title: 'Delete it?' });
    await act(async () => fireEvent.click(screen.getByText('Cancel')));
    expect(no.onAnswer).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('the gravest need the word typed first', async () => {
    const r = await ask({
      title: 'Close 2025-26?',
      confirmLabel: 'Close',
      typeToConfirm: '2025-26',
    });
    const close = screen.getByText('Close') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '2025-26' } });
    expect(close.disabled).toBe(false);
    await act(async () => fireEvent.click(close));
    expect(r.onAnswer).toHaveBeenCalledWith(true);
  });
});

describe('toasts', () => {
  it('show news politely and failures assertively, then go', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast.success('Saved');
      toast.error('Could not send', 'The mail server refused it.');
    });
    expect(screen.getByRole('status').textContent).toContain('Saved');
    expect(screen.getByRole('alert').textContent).toContain('The mail server refused it.');
    act(() => vi.advanceTimersByTime(4_500));
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByText('Could not send')).toBeTruthy();
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.queryByText('Could not send')).toBeNull();
    vi.useRealTimers();
  });
});

describe('server faults', () => {
  it('open the error dialog with the reference to quote', async () => {
    render(<ErrorDialogHost />);
    const api = new ApiClient(
      async () =>
        new Response(JSON.stringify({ statusCode: 500, message: 'Internal server error' }), {
          status: 500,
          headers: { 'content-type': 'application/json', 'x-request-id': 'K7M2PQ9XWA' },
        }),
    );
    await act(async () => {
      await expect(api.request('/api/tenant/projects')).rejects.toMatchObject({
        status: 500,
        ref: 'K7M2PQ9XWA',
      });
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Something went wrong on the server');
    expect(dialog.textContent).toContain('K7M2PQ9XWA');
  });

  it('a refusal (4xx) is the screen’s to explain, not a dialog', async () => {
    render(<ErrorDialogHost />);
    const api = new ApiClient(
      async () =>
        new Response(JSON.stringify({ code: 'stale_row', message: 'Changed' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await act(async () => {
      await expect(api.request('/api/tenant/projects')).rejects.toMatchObject({ status: 409 });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('tabs', () => {
  it('move with the arrow keys and keep one tab stop', () => {
    function Host() {
      const [v, setV] = useState<'a' | 'b' | 'c'>('a');
      return (
        <Tabs
          label="Sections"
          value={v}
          onChange={setV}
          tabs={[
            { id: 'a', label: 'Lines' },
            { id: 'b', label: 'Bills' },
            { id: 'c', label: 'Payments' },
          ]}
        >
          panel {v}
        </Tabs>
      );
    }
    render(<Host />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tabpanel').textContent).toBe('panel c');
    fireEvent.keyDown(screen.getAllByRole('tab')[2]!, { key: 'Home' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Lines');
  });
});
