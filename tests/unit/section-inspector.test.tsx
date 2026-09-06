import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { SectionInspector, type SectionSettings } from '../../src/client/editor/SectionInspector';

const settings: SectionSettings = {
  name: 'Grid section',
  layout: 'grid',
  columns: 3,
  gap: 'medium',
  width: 'shell',
  surface: 'transparent',
  padding: 'medium',
};

describe('SectionInspector', () => {
  it.each([
    ['Section name', 'Updated section', 'name', 'Updated section'],
    ['Section layout', 'flow', 'layout', 'flow'],
    ['Columns', '6', 'columns', 6],
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

  it('hides inapplicable controls for a compatibility section', () => {
    render(
      <SectionInspector settings={{ ...settings, layout: 'compatibility' }} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('Section layout')).toBeVisible();
    expect(screen.queryByLabelText('Columns')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Background')).not.toBeInTheDocument();
  });
});
