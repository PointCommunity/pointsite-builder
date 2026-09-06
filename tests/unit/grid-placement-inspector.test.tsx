import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { setGridBreakpoint } from '../../src/client/editor/GridBreakpointContext';
import { GridPlacementInspector } from '../../src/client/editor/GridPlacementInspector';
import type { ElementPlacement } from '../../src/site-kit/types';

describe('GridPlacementInspector', () => {
  const desktop = { column: 2, row: 3, columnSpan: 6, rowSpan: 4 };

  afterEach(() => setGridBreakpoint('desktop'));

  it('edits exact desktop coordinates', () => {
    const onChange = vi.fn();
    render(<GridPlacementInspector value={{ desktop }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('desktop column'), { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith({
      desktop: { column: 4, row: 3, columnSpan: 6, rowSpan: 4 },
    });
  });

  it('creates and resets an independent tablet override', () => {
    setGridBreakpoint('tablet');
    let changed: ElementPlacement['grid'] | undefined;
    const onChange = vi.fn((value: ElementPlacement['grid']) => {
      changed = value;
    });
    const { rerender } = render(<GridPlacementInspector value={{ desktop }} onChange={onChange} />);
    expect(screen.getByText(/Inheriting the desktop position/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('tablet width in columns'), {
      target: { value: '8' },
    });
    expect(onChange).toHaveBeenCalledWith({
      desktop,
      tablet: { column: 2, row: 3, columnSpan: 8, rowSpan: 4 },
    });

    expect(changed).toBeDefined();
    rerender(<GridPlacementInspector value={changed!} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to desktop' }));
    expect(onChange).toHaveBeenLastCalledWith({ desktop });
  });
});
