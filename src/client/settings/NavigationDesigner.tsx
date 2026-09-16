import { useLayoutEffect, useRef, useState } from 'react';
import type { NavigationEntry, SiteDocument } from '../../site-kit/types';
import { createCompatibilitySection } from '../../site-kit/migrations';
import { LinkDestinationField } from '../editor/LinkDestinationField';
import { Preview } from '../preview/Preview';
import { moveNavigationItem, navigationUsage } from './navigation-designs';

type Design = NonNullable<SiteDocument['navigationDesigns']>[number];

export function NavigationDesigner({
  document,
  selectedId,
  onSelect,
  onChange,
}: {
  document: SiteDocument;
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (designs: Design[]) => void;
}) {
  const designs = document.navigationDesigns ?? [];
  const design = designs.find((item) => item.id === selectedId) ?? designs[0];
  const [itemId, setItemId] = useState('');
  const [message, setMessage] = useState('');
  const root = useRef<HTMLElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const focusItem = useRef(false);
  const dragged = useRef<string | null>(null);
  const rows =
    design?.items.flatMap((item, index) => [
      { item, parentId: null as string | null, index },
      ...item.children.map((child, childIndex) => ({
        item: child,
        parentId: item.id,
        index: childIndex,
      })),
    ]) ?? [];
  const selected = rows.find((row) => row.item.id === itemId) ?? rows[0];
  useLayoutEffect(() => {
    if (focusItem.current) (labelInput.current ?? addButton.current)?.focus();
    focusItem.current = false;
  }, [selected?.item.id]);
  if (!design) return <p>Navigation is unavailable. Reload the draft to try again.</p>;
  const usages = navigationUsage(document, design.id);
  const update = (change: (next: Design) => void) => {
    const next = structuredClone(design);
    change(next);
    onChange(designs.map((item) => (item.id === design.id ? next : item)));
  };
  const navigate = (action: () => void) => {
    const invalid = root.current?.querySelector<HTMLInputElement>(
      ':invalid, [aria-invalid="true"]',
    );
    if (invalid) {
      invalid.reportValidity();
      invalid.focus();
      return;
    }
    action();
  };
  const selectItem = (id: string) =>
    navigate(() => {
      focusItem.current = true;
      setItemId(id);
    });
  const move = (id: string, parentId: string | null, index: number) =>
    navigate(() => {
      const items = moveNavigationItem(design.items, id, parentId, index);
      if (items === design.items) return;
      update((next) => {
        next.items = items;
      });
      setMessage(
        `${rows.find((row) => row.item.id === id)?.item.label ?? 'Item'} moved to position ${index + 1}${parentId ? ` under ${design.items.find((item) => item.id === parentId)?.label}` : ' at the top level'}.`,
      );
    });
  const add = (parentId: string | null) =>
    navigate(() => {
      const id = crypto.randomUUID();
      update((next) => {
        if (parentId)
          next.items
            .find((item) => item.id === parentId)
            ?.children.push({ id, label: 'New child link', href: '/' });
        else next.items.push({ id, label: 'New link', href: '/', children: [] });
      });
      focusItem.current = true;
      setItemId(id);
      setMessage('Link added. Edit its label and destination.');
    });
  const editItem = (
    change: (item: NavigationEntry | NavigationEntry['children'][number]) => void,
  ) => {
    if (!selected) return;
    update((next) => {
      const item = next.items
        .flatMap((item) => [item, ...item.children])
        .find((item) => item.id === selected.item.id);
      if (item) change(item);
    });
  };
  const previewDocument: SiteDocument = {
    ...document,
    pages: [
      {
        ...document.pages[0],
        route: '/',
        blocks: [
          createCompatibilitySection({
            id: design.id,
            type: 'navigation',
            navigationDesignId: design.id,
            label: `${design.name} preview`,
            orientation: 'responsive',
            align: 'left',
            surface: 'canvas',
          }),
        ],
      },
    ],
  };
  const siblings = selected?.parentId
    ? design.items.find((item) => item.id === selected.parentId)!.children
    : design.items;
  const childCount =
    design.items.find((item) => item.id === selected?.item.id)?.children.length ?? 0;
  const hasChildren = childCount > 0;
  return (
    <section className="navigation-designer" aria-labelledby="navigation-designer-title" ref={root}>
      <header className="section-heading">
        <div>
          <p className="eyebrow">Reusable site menus</p>
          <h2 id="navigation-designer-title" tabIndex={-1}>
            Navigation Designer
          </h2>
        </div>
        <p>
          Edit a design once to update every Layout element using it. Placement and appearance stay
          in Layout.
        </p>
      </header>
      <div className="navigation-design-toolbar">
        <label>
          <span>Navigation design</span>
          <select
            data-local-control
            value={design.id}
            onChange={(event) =>
              navigate(() => {
                onSelect(event.target.value);
                setItemId('');
              })
            }
          >
            {designs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button"
          disabled={designs.length >= 30}
          onClick={() =>
            navigate(() => {
              const next = { id: crypto.randomUUID(), name: 'New navigation', items: [] };
              onChange([...designs, next]);
              onSelect(next.id);
              setItemId('');
              setMessage('Navigation design created. Add a link to get started.');
            })
          }
        >
          New design
        </button>
        <label>
          <span>Design name</span>
          <input
            required
            maxLength={120}
            value={design.name}
            onChange={(event) =>
              update((next) => {
                next.name = event.target.value;
              })
            }
          />
        </label>
        <button
          type="button"
          className="button button--danger"
          disabled={usages.length > 0 || designs.length === 1}
          aria-describedby="navigation-delete-guidance"
          onClick={() => {
            if (
              navigationUsage(document, design.id).length ||
              designs.length === 1 ||
              !window.confirm(`Delete the Navigation design “${design.name}”?`)
            )
              return;
            const remaining = designs.filter((item) => item.id !== design.id);
            onChange(remaining);
            onSelect(remaining[0].id);
            setItemId('');
            setMessage('Navigation design deleted.');
          }}
        >
          Delete design
        </button>
      </div>
      <p id="navigation-delete-guidance">
        {usages.length
          ? `Used by ${usages.length} Navigation ${usages.length === 1 ? 'element' : 'elements'}. Reassign or remove them in Layout before deleting this design.`
          : designs.length === 1
            ? 'Keep at least one Navigation design.'
            : 'Not used in Layout. This design can be deleted.'}
      </p>
      {usages.length ? (
        <details className="navigation-usage">
          <summary>Where this design is used</summary>
          <ul>
            {usages.map((use) => (
              <li key={use.elementId}>
                {use.pageTitle} — {use.label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="navigation-editing-layout">
        <section aria-labelledby="menu-outline-title" className="navigation-outline">
          <h3 id="menu-outline-title">Menu outline</h3>
          <p id="menu-move-guidance">
            Drag links within their level to reorder. Move buttons and Parent link provide keyboard
            and touch alternatives.
          </p>
          {!rows.length ? <p>No links yet. Add a top-level link below.</p> : null}
          <ol className="navigation-items" aria-describedby="menu-move-guidance">
            {rows.map((row) => (
              <li
                key={row.item.id}
                className={
                  row.parentId ? 'navigation-item navigation-item--child' : 'navigation-item'
                }
              >
                <button
                  type="button"
                  className="question-summary"
                  aria-pressed={selected?.item.id === row.item.id}
                  draggable
                  onClick={() => selectItem(row.item.id)}
                  onDragStart={(event) => {
                    dragged.current = row.item.id;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', row.item.id);
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                  }}
                  onDragOver={(event) => {
                    if (
                      rows.find((item) => item.item.id === dragged.current)?.parentId ===
                      row.parentId
                    )
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source = rows.find((item) => item.item.id === dragged.current);
                    dragged.current = null;
                    if (source && source.parentId === row.parentId)
                      move(source.item.id, row.parentId, row.index);
                  }}
                >
                  <strong>
                    {row.parentId ? 'Child: ' : `${row.index + 1}. `}
                    {row.item.label || 'Untitled link'}
                  </strong>
                  <span>{row.item.href}</span>
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="button"
            disabled={design.items.length >= 20}
            ref={addButton}
            onClick={() => add(null)}
          >
            Add top-level link
          </button>
        </section>
        <section className="navigation-item-editor" aria-labelledby="menu-item-title">
          <h3 id="menu-item-title">{selected ? 'Selected link' : 'Link details'}</h3>
          {selected ? (
            <div key={selected.item.id} className="settings-list">
              <label>
                <span>Link label</span>
                <input
                  ref={labelInput}
                  required
                  maxLength={60}
                  value={selected.item.label}
                  onChange={(event) =>
                    editItem((item) => {
                      item.label = event.target.value;
                    })
                  }
                />
              </label>
              <LinkDestinationField
                label="Destination"
                value={selected.item.href}
                pages={document.pages}
                onChange={(href) =>
                  editItem((item) => {
                    item.href = href;
                  })
                }
              />
              <label>
                <span>Parent link</span>
                <select
                  data-local-control
                  value={selected.parentId ?? ''}
                  disabled={Boolean(hasChildren)}
                  aria-describedby="menu-parent-guidance"
                  onChange={(event) => {
                    const parent = event.target.value || null;
                    const length = parent
                      ? design.items.find((item) => item.id === parent)!.children.length
                      : design.items.length;
                    move(selected.item.id, parent, length);
                  }}
                >
                  <option
                    value=""
                    disabled={selected.parentId !== null && design.items.length >= 20}
                  >
                    Top level
                  </option>
                  {design.items
                    .filter((item) => item.id !== selected.item.id)
                    .map((item) => (
                      <option
                        key={item.id}
                        value={item.id}
                        disabled={item.children.length >= 12 && item.id !== selected.parentId}
                      >
                        {item.label}
                      </option>
                    ))}
                </select>
              </label>
              <p id="menu-parent-guidance">
                {hasChildren
                  ? 'A link with children must stay at the top level. Move its children first.'
                  : 'Only one child level is supported.'}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button"
                  disabled={selected.index === 0}
                  onClick={() => move(selected.item.id, selected.parentId, selected.index - 1)}
                >
                  Move earlier
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={selected.index === siblings.length - 1}
                  onClick={() => move(selected.item.id, selected.parentId, selected.index + 1)}
                >
                  Move later
                </button>
                {!selected.parentId ? (
                  <button
                    type="button"
                    className="button"
                    disabled={childCount >= 12}
                    onClick={() => add(selected.item.id)}
                  >
                    Add child link
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => {
                    if (
                      hasChildren &&
                      !window.confirm(`Remove “${selected.item.label}” and its child links?`)
                    )
                      return;
                    const fallback = rows.find(
                      (row) =>
                        row.item.id !== selected.item.id && row.parentId !== selected.item.id,
                    );
                    update((next) => {
                      next.items = next.items
                        .filter((item) => item.id !== selected.item.id)
                        .map((item) => ({
                          ...item,
                          children: item.children.filter((child) => child.id !== selected.item.id),
                        }));
                    });
                    focusItem.current = true;
                    setItemId(fallback?.item.id ?? '');
                    setMessage(`${selected.item.label} removed.`);
                  }}
                >
                  {hasChildren ? 'Remove link and children' : 'Remove link'}
                </button>
              </div>
            </div>
          ) : (
            <p>Select or add a link to edit its label and destination.</p>
          )}
        </section>
      </div>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <details
        className="navigation-preview"
        open
        onClickCapture={(event) => {
          // React portal events from the preview iframe still reach this boundary.
          if ((event.target as Element).closest('a[href]')) event.preventDefault();
        }}
      >
        <summary>Representative menu preview</summary>
        <p>
          Preview links stay inside the Builder. Menu appearance and placement can differ by Layout
          element.
        </p>
        <Preview document={previewDocument} />
      </details>
    </section>
  );
}
