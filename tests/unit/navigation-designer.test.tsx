import { navigationUsage, moveNavigationItem } from '../../src/client/settings/navigation-designs';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { upgradeNavigation } from '../../src/site-kit/migrations';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NavigationDesigner } from '../../src/client/settings/NavigationDesigner';
import type { SiteDocument } from '../../src/site-kit/types';

vi.mock('../../src/client/preview/Preview', () => ({ Preview: () => <div>Renderer preview</div> }));

function Workspace({
  initial = upgradeNavigation(defaultSiteDocument),
}: {
  initial?: SiteDocument;
}) {
  const [document, setDocument] = useState(initial);
  const [selectedId, onSelect] = useState('');
  return (
    <NavigationDesigner
      document={document}
      selectedId={selectedId}
      onSelect={onSelect}
      onChange={(navigationDesigns) => setDocument({ ...document, navigationDesigns })}
    />
  );
}

const menu = () => [
  {
    id: 'a',
    label: 'About',
    href: '/about',
    children: [{ id: 'c', label: 'Child', href: '/child' }],
  },
  { id: 'b', label: 'Contact', href: '/contact', children: [] },
];

describe('Navigation Designer item movements', () => {
  it('reorders parents and children without changing identity or destinations', () => {
    const original = menu();
    const moved = moveNavigationItem(original, 'b', null, 0);
    expect(moved.map((item) => item.id)).toEqual(['b', 'a']);
    expect(moved[1]).toEqual(original[0]);
    expect(original).toEqual(menu());
    const children = [
      {
        ...original[0],
        children: [...original[0].children, { id: 'd', label: 'Other', href: '/other' }],
      },
    ];
    expect(moveNavigationItem(children, 'd', 'a', 0)[0].children.map((item) => item.id)).toEqual([
      'd',
      'c',
    ]);
  });
  it('nests and promotes leaf items without losing content', () => {
    const nested = moveNavigationItem(menu(), 'b', 'a', 1);
    expect(nested).toHaveLength(1);
    expect(nested[0].children[1]).toEqual({ id: 'b', label: 'Contact', href: '/contact' });
    expect(moveNavigationItem(nested, 'b', null, 0)[0]).toEqual(menu()[1]);
  });
  it('rejects grandchildren, unknown parents, cycles and capacity overflow', () => {
    const items = menu();
    for (const [id, parent] of [
      ['a', 'b'],
      ['b', 'c'],
      ['b', 'missing'],
      ['b', 'b'],
    ])
      expect(moveNavigationItem(items, id, parent, 0)).toBe(items);
    const full = [
      {
        ...items[0],
        children: Array.from({ length: 12 }, (_, i) => ({
          id: `c${i}`,
          label: 'Child',
          href: '/',
        })),
      },
      items[1],
    ];
    expect(moveNavigationItem(full, 'b', 'a', 0)).toBe(full);
    const parents = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      label: 'Parent',
      href: '/',
      children: [] as { id: string; label: string; href: string }[],
    }));
    parents[0].children.push({ id: 'child', label: 'Child', href: '/' });
    expect(moveNavigationItem(parents, 'child', null, 0)).toBe(parents);
  });
  it('finds every referencing element across pages for safe deletion', () => {
    const document = upgradeNavigation(defaultSiteDocument);
    const id = document.navigationDesigns![0].id;
    const usages = navigationUsage(document, id);
    expect(usages.length).toBe(document.pages.length);
    expect(usages.every((use) => use.pageId && use.elementId && use.pageTitle)).toBe(true);
    expect(navigationUsage(document, 'missing')).toEqual([]);
  });
});

describe('Navigation Designer workspace', () => {
  it('creates, selects and renames designs while protecting referenced designs', () => {
    render(<Workspace />);
    expect(screen.getByRole('heading', { name: 'Navigation Designer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete design' })).toBeDisabled();
    expect(screen.getByText(/Reassign or remove them in Layout/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New design' }));
    expect(screen.getByText('No links yet. Add a top-level link below.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Design name'), {
      target: { value: 'Footer navigation' },
    });
    expect(screen.getByRole('option', { name: 'Footer navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete design' })).toBeEnabled();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete design' }));
    expect(screen.queryByRole('option', { name: 'Footer navigation' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Design name')).toHaveValue('Main navigation');
  });
  it('adds items with focus and offers keyboard nesting, promotion and reordering', () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole('button', { name: 'New design' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add top-level link' }));
    expect(screen.getByLabelText('Link label')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Link label'), { target: { value: 'First' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add top-level link' }));
    fireEvent.change(screen.getByLabelText('Link label'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move earlier' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Second moved to position 1 at the top level',
    );
    const parent = screen.getByLabelText('Parent link');
    const firstId = within(parent).getByRole('option', { name: 'First' }).getAttribute('value');
    fireEvent.change(parent, { target: { value: firstId } });
    expect(screen.getByRole('button', { name: /Child: Second/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add child link' })).not.toBeInTheDocument();
    fireEvent.change(parent, { target: { value: '' } });
    expect(screen.getByRole('button', { name: /2. Second/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(screen.queryByRole('button', { name: /Second/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Link label')).toHaveFocus();
  });
  it('returns focus to adding a link after removing the last link', () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole('button', { name: 'New design' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add top-level link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(screen.getByRole('button', { name: 'Add top-level link' })).toHaveFocus();
  });
  it('keeps invalid destination text visible and prevents losing it by changing selection', () => {
    render(<Workspace />);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'external' } });
    fireEvent.change(screen.getByLabelText('External URL'), {
      target: { value: 'javascript:alert(1)' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New design' }));
    expect(screen.getByLabelText('External URL')).toHaveValue('javascript:alert(1)');
    expect(screen.getByLabelText('External URL')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Design name')).toHaveValue('Main navigation');
  });
  it('reorders by dragging through the same movement operation', () => {
    render(<Workspace />);
    const first = screen.getByRole('button', { name: /^1\. About/ });
    const second = screen.getByRole('button', { name: /^2\. Connect/ });
    const dataTransfer = { effectAllowed: '', setData: vi.fn() };
    fireEvent.dragStart(second, { dataTransfer });
    fireEvent.dragOver(first, { dataTransfer });
    fireEvent.drop(first, { dataTransfer });
    expect(screen.getByRole('button', { name: /^1\. Connect/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Connect moved to position 1');
  });
});
