import { blockDefinitions } from '../../site-kit/registry';
import type { SiteBlock } from '../../site-kit/types';
import { useEditor } from './EditorProvider';

export function StructurePanel({ pageId }: { pageId: string }) {
  const { document, updateDocument } = useEditor();
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) return null;
  const move = (index: number, delta: number) =>
    updateDocument((next) => {
      const target = next.pages.find((candidate) => candidate.id === pageId);
      if (!target) return next;
      const destination = index + delta;
      if (destination < 0 || destination >= target.blocks.length) return next;
      const blocks = [...target.blocks];
      const [item] = blocks.splice(index, 1);
      if (item) blocks.splice(destination, 0, item);
      target.blocks = blocks;
      return next;
    });
  const remove = (id: string) =>
    updateDocument((next) => {
      const target = next.pages.find((candidate) => candidate.id === pageId);
      if (target) target.blocks = target.blocks.filter((block) => block.id !== id);
      return next;
    });
  return (
    <section className="structure-panel" aria-labelledby="structure-title">
      <h2 id="structure-title">Page structure</h2>
      <p>Every drag action has a button equivalent.</p>
      <ol>
        {page.blocks.map((block: SiteBlock, index) => (
          <li key={block.id}>
            <span>{blockDefinitions[block.type].label}</span>
            <div className="icon-buttons">
              <button
                disabled={index === 0}
                onClick={() => move(index, -1)}
                aria-label={`Move ${blockDefinitions[block.type].label} up`}
              >
                ↑
              </button>
              <button
                disabled={index === page.blocks.length - 1}
                onClick={() => move(index, 1)}
                aria-label={`Move ${blockDefinitions[block.type].label} down`}
              >
                ↓
              </button>
              <button
                onClick={() => remove(block.id)}
                aria-label={`Remove ${blockDefinitions[block.type].label}`}
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
