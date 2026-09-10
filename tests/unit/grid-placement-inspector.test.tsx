import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { setGridBreakpoint } from '../../src/client/editor/GridBreakpointContext';
import { GridPlacementInspector } from '../../src/client/editor/GridPlacementInspector';
import type { ElementPlacement } from '../../src/site-kit/types';
import { independentGridArea } from '../../src/site-kit/grid-layout';

describe('GridPlacementInspector', () => {
  const desktop = { column: 2, row: 3, columnSpan: 6, rowSpan: 4 };

  afterEach(() => setGridBreakpoint('desktop'));

  it('edits exact desktop coordinates', () => {
    const onChange = vi.fn();
    render(<GridPlacementInspector value={independentGridArea(desktop)} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('desktop column'), { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith({
      desktop: { column: 4, row: 3, columnSpan: 6, rowSpan: 4 },
      tablet: desktop,
      mobile: desktop,
    });
  });

  it('edits tablet without changing desktop or mobile', () => {
    setGridBreakpoint('tablet');
    let changed: ElementPlacement['grid'] | undefined;
    const onChange = vi.fn((value: ElementPlacement['grid']) => {
      changed = value;
    });
    render(<GridPlacementInspector value={independentGridArea(desktop)} onChange={onChange} />);
    expect(screen.getByText(/belongs only to the selected responsive view/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('tablet width in columns'), {
      target: { value: '8' },
    });
    expect(onChange).toHaveBeenCalledWith({
      desktop,
      tablet: { column: 2, row: 3, columnSpan: 8, rowSpan: 4 },
      mobile: desktop,
    });
    expect(changed?.desktop).toEqual(desktop);
    expect(changed?.mobile).toEqual(desktop);
    expect(screen.queryByRole('button', { name: 'Reset to desktop' })).not.toBeInTheDocument();
  });
});
