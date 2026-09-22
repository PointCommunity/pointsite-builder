import { fireEvent, render, screen } from '@testing-library/react';
import { FormsEditor } from '../../src/client/settings/FormsEditor';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { validSiteDocument } from '../fixtures/site-documents';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

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
  fireEvent.click(screen.getByRole('button', { name: 'Form details' }));

  const deleteButton = screen.getByRole('button', { name: 'Used in Layout' });
  expect(deleteButton).toBeDisabled();
  fireEvent.click(deleteButton);
  expect(onChange).not.toHaveBeenCalled();
});

it('offers a version-12 form grid with collision-safe, keyboard-ordered field controls', () => {
  const forms = structuredClone(SiteDocumentSchema.parse(validSiteDocument).forms);
  forms[0].fields.push({
    ...forms[0].fields[0],
    id: crypto.randomUUID(),
    name: 'second',
    label: 'Second',
  });
  const onChange = vi.fn();
  const { rerender } = render(<FormsEditor forms={forms} schemaVersion={12} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Form details' }));
  fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'grid' } });
  const next = onChange.mock.calls.at(-1)?.[0] as typeof forms;
  expect(next[0].layout).toBe('grid');
  expect(next[0].fields.map((field) => field.grid?.desktop.row)).toEqual([1, 2]);
  expect(
    SiteDocumentSchema.safeParse({
      ...defaultSiteDocument,
      schemaVersion: 12,
      rendererVersion: '12.0.0',
      forms: next,
    }).success,
  ).toBe(true);
  rerender(<FormsEditor forms={next} schemaVersion={12} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Questions' }));
  const preview = screen.getByLabelText('desktop form grid');
  Object.defineProperty(preview, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 1200 }),
  });
  const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => next[0].fields[1].id) };
  fireEvent.dragStart(screen.getByRole('button', { name: 'Second' }), { dataTransfer });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(drop, { dataTransfer, clientX: 10, clientY: 136 });
  fireEvent(preview, drop);
  expect(dataTransfer.getData).toHaveBeenCalledWith('application/x-point-form-field');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  const placed = onChange.mock.calls.at(-1)?.[0] as typeof forms;
  expect(placed[0].fields[1].grid?.desktop).toMatchObject({ column: 1, row: 3 });
  rerender(<FormsEditor forms={next} schemaVersion={12} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /2\. Second/ }));
  const selected = document.querySelector<HTMLElement>('.form-field-editor:not([hidden])')!;
  fireEvent.change(selected.querySelector<HTMLInputElement>('input[value="2"]')!, {
    target: { value: '1' },
  });
  expect(screen.getByRole('alert')).toHaveTextContent('cannot overlap');
  expect(onChange.mock.calls.at(-1)?.[0]).toBe(placed);
  fireEvent.click(screen.getByRole('button', { name: 'Move Second up' }));
  const moved = onChange.mock.calls.at(-1)?.[0] as typeof forms;
  expect(moved[0].fields.map((field) => field.label)).toEqual(['Second', 'Message']);
  expect(moved[0].fields.map((field) => field.grid?.desktop.row)).toEqual([1, 2]);
});
