import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { SectionInspector, type SectionSettings } from '../../src/client/editor/SectionInspector';

const settings: SectionSettings = {
  name: 'Grid section',
  layout: 'grid',
  position: 'flow',
  columns: 3,
  gap: 'medium',
  width: 'shell',
  surface: 'transparent',
  padding: 'medium',
  minRows: 8,
  backgroundPosition: 'center',
  overlay: 'none',
};

describe('SectionInspector', () => {
  it.each([
    ['Section name', 'Updated section', 'name', 'Updated section'],
    ['Section layout', 'flow', 'layout', 'flow'],
    ['Content width', 'narrow', 'width', 'narrow'],
    ['Background', 'primary', 'surface', 'primary'],
    ['Spacing', 'large', 'padding', 'large'],
    ['Element gap', 'small', 'gap', 'small'],
  ] as const)(
    'updates %s with an observable section setting',
    (label, value, property, expected) => {
      const onChange = vi.fn();
      const { unmount } = render(<SectionInspector settings={settings} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ [property]: expected }));
      unmount();
    },
  );

  it('keeps every customizable grid section on the standard twelve-column system', () => {
    const onChange = vi.fn();
    render(
      <SectionInspector
        settings={{ ...settings, layout: 'flow', columns: 1 }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Section layout'), { target: { value: 'grid' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ layout: 'grid', columns: 12 }));
  });

  it('hides inapplicable controls for a compatibility section', () => {
    render(
      <SectionInspector settings={{ ...settings, layout: 'compatibility' }} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('Section layout')).toBeVisible();
    expect(screen.queryByLabelText('Columns')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Background')).not.toBeInTheDocument();
  });

  it('explains the fixed twelve-column grid instead of exposing a misleading control', () => {
    render(<SectionInspector settings={settings} onChange={vi.fn()} />);
    expect(screen.getByText('Standard responsive grid: 12 columns')).toBeVisible();
    expect(screen.queryByLabelText('Columns')).not.toBeInTheDocument();
  });
});
