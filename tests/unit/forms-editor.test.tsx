import { fireEvent, render, screen } from '@testing-library/react';
import { FormsEditor } from '../../src/client/settings/FormsEditor';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { validSiteDocument } from '../fixtures/site-documents';

it('creates and configures a friendly form without exposing technical field keys', () => {
  const forms = structuredClone(SiteDocumentSchema.parse(validSiteDocument).forms);
  const onChange = vi.fn();
  const { rerender } = render(<FormsEditor forms={forms} onChange={onChange} />);
  expect(screen.queryByText('Field key')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New form' }));
  const next = onChange.mock.calls.at(-1)?.[0] as typeof forms;
  expect(next).toHaveLength(2);
  expect(next[1]).toMatchObject({ layout: 'single', density: 'comfortable' });
  rerender(<FormsEditor forms={next} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
  const withField = onChange.mock.calls.at(-1)?.[0] as typeof forms;
  expect(withField[1].fields).toHaveLength(2);
  expect(withField[1].fields[1]).toMatchObject({ type: 'text', width: 'full' });
});

it('does not delete a form that is currently used in Layout', () => {
  const forms = structuredClone(SiteDocumentSchema.parse(validSiteDocument).forms);
  const onChange = vi.fn();
  render(<FormsEditor forms={forms} usedFormIds={new Set([forms[0].id])} onChange={onChange} />);

  const deleteButton = screen.getByRole('button', { name: 'Used in Layout' });
  expect(deleteButton).toBeDisabled();
  fireEvent.click(deleteButton);
  expect(onChange).not.toHaveBeenCalled();
});
