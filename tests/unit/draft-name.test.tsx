import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DraftName } from '../../src/client/editor/DraftName';

function setup(rename = vi.fn().mockResolvedValue(undefined), editable = true) {
  render(<DraftName name="Sunday" editable={editable} onRename={rename} />);
  return rename;
}

describe('DraftName', () => {
  it('selects the name on double click, trims a save, and restores focus', async () => {
    const rename = setup();
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Sunday' }));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Draft name' });
    expect(input).toHaveFocus();
    expect(input.selectionEnd).toBe(6);
    fireEvent.change(input, { target: { value: '  Next Sunday  ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(rename).toHaveBeenCalledWith('Next Sunday'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename draft' })).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Draft name saved');
  });

  it('cancels via Escape and skips unchanged values', async () => {
    const rename = setup();
    const button = screen.getByRole('button', { name: 'Rename draft' });
    fireEvent.click(button);
    fireEvent.change(screen.getByLabelText('Draft name'), { target: { value: 'Discard' } });
    fireEvent.keyDown(screen.getByLabelText('Draft name'), { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename draft' })).toHaveFocus());
    expect(screen.getByRole('heading')).toHaveTextContent('Sunday');
    fireEvent.click(screen.getByRole('button', { name: 'Rename draft' }));
    fireEvent.change(screen.getByLabelText('Draft name'), { target: { value: ' Sunday ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(rename).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'x'.repeat(101)])('rejects invalid input (%s)', (value) => {
    const rename = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Rename draft' }));
    const input = screen.getByLabelText('Draft name');
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('1–100 characters');
    expect(rename).not.toHaveBeenCalled();
  });

  it('keeps failed input for retry and exposes separate saving feedback without duplicate requests', async () => {
    let reject!: () => void;
    const rename = setup(
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_, fail) => {
              reject = () => fail(new Error('network'));
            }),
        )
        .mockResolvedValue(undefined),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename draft' }));
    fireEvent.change(screen.getByLabelText('Draft name'), { target: { value: 'Retry name' } });
    const form = screen.getByLabelText('Draft name').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Saving draft name');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(() => {
      reject();
      return Promise.resolve();
    });
    expect(screen.getByLabelText('Draft name')).toHaveValue('Retry name');
    expect(screen.getByRole('alert')).toHaveTextContent('Try again');
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Draft name saved'));
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('does not submit composition Enter or save on blur', () => {
    const rename = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Rename draft' }));
    const input = screen.getByLabelText('Draft name');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.blur(input);
    expect(input).toBeInTheDocument();
    expect(rename).not.toHaveBeenCalled();
  });

  it('exposes no rename interaction when not editable', () => {
    setup(undefined, false);
    fireEvent.doubleClick(screen.getByRole('heading'));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
