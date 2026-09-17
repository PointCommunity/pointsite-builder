import { useLayoutEffect, useRef } from 'react';
import type { SiteBlock } from '../../site-kit/types';
import {
  documentRegions,
  layoutSections,
  replaceLayoutSections,
} from '../../site-kit/document-sections';
import { useEditor } from './EditorProvider';
import { mutationForContext } from './action-attribution';

export function StructurePanel({
  pageId,
  onStructureChange,
  setStatus,
  focus,
}: {
  pageId: string;
  onStructureChange: () => void;
  setStatus: (status: string) => void;
  focus: string;
}) {
  const { document, updateDocument } = useEditor();
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!focus) return;
    const controls = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    (
      controls.find((button) => button.getAttribute('aria-label') === focus) ?? controls[0]
    )?.focus();
  }, [focus]);
  const page = documentRegions(document).find((candidate) => candidate.id === pageId);
  if (!page) return null;
  const move = (index: number, delta: number) => {
    const moved = page.blocks[index];
    updateDocument(
      (next) => {
        const target = layoutSections(next, pageId);
        if (!target) return next;
        const destination = index + delta;
        if (destination < 0 || destination >= target.length) return next;
        const blocks = [...target];
        const [item] = blocks.splice(index, 1);
        if (item) blocks.splice(destination, 0, item);
        replaceLayoutSections(next, pageId, blocks);
        return next;
      },
      mutationForContext('page-structure', 'reorder'),
    );
    onStructureChange();
    if (moved) setStatus(`${moved.name} moved.`);
  };
  const remove = (id: string) => {
    updateDocument(
      (next) => {
        const target = layoutSections(next, pageId);
        if (target)
          replaceLayoutSections(
            next,
            pageId,
            target.filter((block) => block.id !== id),
          );
        return next;
      },
      mutationForContext('page-structure', 'remove'),
    );
    onStructureChange();
    setStatus('Section removed.');
  };
  const duplicate = (id: string) => {
    const source = page.blocks.find((block) => block.id === id);
    updateDocument(
      (next) => {
        const target = layoutSections(next, pageId);
        const index = target?.findIndex((block) => block.id === id) ?? -1;
        if (!target || index < 0) return next;
        const copy = structuredClone(target[index]);
        copy.id = crypto.randomUUID();
        copy.name = `${copy.name} copy`;
        copy.items = copy.items.map((placement) => ({
          ...placement,
          id: crypto.randomUUID(),
          element: { ...placement.element, id: crypto.randomUUID() },
        }));
        target.splice(index + 1, 0, copy);
        return next;
      },
      mutationForContext('page-structure', 'duplicate'),
    );
    onStructureChange();
    if (source) setStatus(`${source.name} duplicated.`);
  };
  return (
    <section ref={root} className="structure-panel" aria-labelledby="structure-title">
      <h2 id="structure-title">Page structure</h2>
      <p>Every drag action has a button equivalent.</p>
      <ol>
        {page.blocks.map((block: SiteBlock, index) => (
          <li key={block.id}>
            <span>{block.name}</span>
            <div className="icon-buttons">
              <button
                disabled={index === 0}
                onClick={() => move(index, -1)}
                aria-label={`Move ${block.name} up`}
              >
                ↑
              </button>
              <button
                disabled={index === page.blocks.length - 1}
                onClick={() => move(index, 1)}
                aria-label={`Move ${block.name} down`}
              >
                ↓
              </button>
              <button onClick={() => duplicate(block.id)} aria-label={`Duplicate ${block.name}`}>
                ⧉
              </button>
              <button onClick={() => remove(block.id)} aria-label={`Remove ${block.name}`}>
                ×
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
