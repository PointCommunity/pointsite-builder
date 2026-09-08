import { useState } from 'react';
import type { SiteBlock } from '../../site-kit/types';
import { useEditor } from './EditorProvider';
import { mutationForContext } from './action-attribution';

export function StructurePanel({
  pageId,
  onStructureChange,
}: {
  pageId: string;
  onStructureChange: () => void;
}) {
  const { document, updateDocument } = useEditor();
  const [status, setStatus] = useState('');
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) return null;
  const move = (index: number, delta: number) => {
    const moved = page.blocks[index];
    updateDocument(
      (next) => {
        const target = next.pages.find((candidate) => candidate.id === pageId);
        if (!target) return next;
        const destination = index + delta;
        if (destination < 0 || destination >= target.blocks.length) return next;
        const blocks = [...target.blocks];
        const [item] = blocks.splice(index, 1);
        if (item) blocks.splice(destination, 0, item);
        target.blocks = blocks;
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
        const target = next.pages.find((candidate) => candidate.id === pageId);
        if (target) target.blocks = target.blocks.filter((block) => block.id !== id);
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
        const target = next.pages.find((candidate) => candidate.id === pageId);
        const index = target?.blocks.findIndex((block) => block.id === id) ?? -1;
        if (!target || index < 0) return next;
        const copy = structuredClone(target.blocks[index]);
        copy.id = crypto.randomUUID();
        copy.name = `${copy.name} copy`;
        copy.items = copy.items.map((placement) => ({
          ...placement,
          id: crypto.randomUUID(),
          element: { ...placement.element, id: crypto.randomUUID() },
        }));
        target.blocks.splice(index + 1, 0, copy);
        return next;
      },
      mutationForContext('page-structure', 'duplicate'),
    );
    onStructureChange();
    if (source) setStatus(`${source.name} duplicated.`);
  };
  return (
    <section className="structure-panel" aria-labelledby="structure-title">
      <h2 id="structure-title">Page structure</h2>
      <p>Every drag action has a button equivalent.</p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
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
