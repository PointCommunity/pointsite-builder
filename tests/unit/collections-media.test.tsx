import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { CollectionsEditor } from '../../src/client/settings/CollectionsEditor';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

it('edits one person photo without changing sibling media choices', () => {
  const document = {
    ...defaultSiteDocument,
    schemaVersion: 12 as const,
    rendererVersion: '12.0.0',
  };
  const onChange = vi.fn();
  render(<CollectionsEditor document={document} onChange={onChange} />);
  fireEvent.change(screen.getAllByLabelText('Photo fit')[0], { target: { value: 'stretch' } });
  expect(onChange).toHaveBeenCalledWith({
    ...document.collections,
    people: document.collections.people.map((person, index) =>
      index ? person : { ...person, mediaFit: 'stretch' },
    ),
  });
  fireEvent.change(screen.getAllByLabelText('Photo frame')[0], { target: { value: 'square' } });
  expect(onChange).toHaveBeenCalledWith({
    ...document.collections,
    people: document.collections.people.map((person, index) =>
      index ? person : { ...person, mediaFrame: 'square' },
    ),
  });
});
