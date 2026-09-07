import type { SiteDocument } from '../../site-kit/types';
import { createEditableHeaderSection } from '../../site-kit/editable-header';
import { useEditor } from './EditorProvider';

// This colocated pure helper keeps page creation and its tests bound to the UI behavior.
// eslint-disable-next-line react-refresh/only-export-components
export function availableRoute(title: string, routes: string[]): string {
  const slug =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'page';
  const route = `/${slug}`;
  if (!routes.includes(route)) return route;
  let suffix = 2;
  while (routes.includes(`${route}-${suffix}`)) suffix += 1;
  return `${route}-${suffix}`;
}

export function PageManager({
  pageId,
  onPageIdChange,
}: {
  pageId: string;
  onPageIdChange: (id: string) => void;
}) {
  const { document, updateDocument } = useEditor();
  const page = document.pages.find((item) => item.id === pageId) ?? document.pages[0];
  if (!page) return null;
  const index = document.pages.findIndex((item) => item.id === page.id);

  const updatePage = (change: (target: SiteDocument['pages'][number]) => void) =>
    updateDocument((next) => {
      const target = next.pages.find((item) => item.id === page.id);
      if (target) change(target);
      return next;
    });

  const move = (delta: number) =>
    updateDocument((next) => {
      const from = next.pages.findIndex((item) => item.id === page.id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= next.pages.length) return next;
      const [item] = next.pages.splice(from, 1);
      if (item) next.pages.splice(to, 0, item);
      return next;
    });

  const create = () => {
    const title = 'New page';
    const id = crypto.randomUUID();
    updateDocument((next) => {
      const logo = next.media.find((item) => item.sourcePath.endsWith('/point-logo.png'));
      next.pages.push({
        id,
        title,
        route: availableRoute(
          title,
          next.pages.map((item) => item.route),
        ),
        status: 'draft',
        template: 'standard',
        eyebrow: 'New page',
        intro: 'Add a short introduction for this page.',
        metadata: { title, description: 'Add a short description for this page.' },
        blocks: [createEditableHeaderSection(id, logo?.id)],
      });
      return next;
    });
    onPageIdChange(id);
  };

  const duplicate = () => {
    const id = crypto.randomUUID();
    updateDocument((next) => {
      const source = next.pages.find((item) => item.id === page.id);
      if (!source) return next;
      const title = `${source.title} copy`;
      const copy = structuredClone(source);
      copy.id = id;
      copy.title = title;
      copy.route = availableRoute(
        title,
        next.pages.map((item) => item.route),
      );
      copy.status = 'draft';
      copy.metadata.title = title.slice(0, 70);
      copy.blocks = copy.blocks.map((section) => ({
        ...section,
        id: crypto.randomUUID(),
        items: section.items.map((placement) => ({
          ...placement,
          id: crypto.randomUUID(),
          element: { ...placement.element, id: crypto.randomUUID() },
        })),
      }));
      next.pages.splice(next.pages.indexOf(source) + 1, 0, copy);
      return next;
    });
    onPageIdChange(id);
  };

  const remove = () => {
    if (document.pages.length === 1) return;
    if (!window.confirm(`Delete “${page.title}” from this draft?`)) return;
    const fallback = document.pages[index === 0 ? 1 : index - 1];
    updateDocument((next) => {
      next.pages = next.pages.filter((item) => item.id !== page.id);
      return next;
    });
    if (fallback) onPageIdChange(fallback.id);
  };

  return (
    <section className="page-manager" aria-labelledby="page-manager-title">
      <h2 id="page-manager-title">Page</h2>
      <label>
        <span>Choose page</span>
        <select value={page.id} onChange={(event) => onPageIdChange(event.target.value)}>
          {document.pages.map((item) => (
            <option value={item.id} key={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </label>
      <div className="page-actions">
        <button type="button" className="button" onClick={create}>
          New
        </button>
        <button type="button" className="button" onClick={duplicate}>
          Duplicate
        </button>
        <button
          type="button"
          className="button"
          disabled={index === 0}
          onClick={() => move(-1)}
          aria-label={`Move ${page.title} earlier`}
        >
          ↑
        </button>
        <button
          type="button"
          className="button"
          disabled={index === document.pages.length - 1}
          onClick={() => move(1)}
          aria-label={`Move ${page.title} later`}
        >
          ↓
        </button>
        <button
          type="button"
          className="button button--danger"
          disabled={document.pages.length === 1}
          onClick={remove}
        >
          Delete
        </button>
      </div>
      <details>
        <summary>Page details</summary>
        <div className="inspector-grid page-details">
          <label>
            <span>Page name</span>
            <input
              required
              maxLength={120}
              value={page.title}
              onChange={(event) =>
                updatePage((target) => {
                  target.title = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>Web address</span>
            <input
              required
              pattern="/[a-z0-9/-]*"
              value={page.route}
              onChange={(event) =>
                updatePage((target) => {
                  target.route = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>Visibility</span>
            <select
              value={page.status}
              onChange={(event) =>
                updatePage((target) => {
                  target.status = event.target.value as typeof target.status;
                })
              }
            >
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          <label>
            <span>Page layout</span>
            <select
              value={page.template ?? (page.route === '/' ? 'home' : 'standard')}
              onChange={(event) =>
                updatePage((target) => {
                  target.template = event.target.value as 'home' | 'standard';
                })
              }
            >
              <option value="standard">Standard page</option>
              <option value="home">Homepage</option>
            </select>
          </label>
          <label>
            <span>Page eyebrow</span>
            <input
              maxLength={80}
              value={page.eyebrow ?? ''}
              onChange={(event) =>
                updatePage((target) => {
                  target.eyebrow = event.target.value || undefined;
                })
              }
            />
          </label>
          <label className="field-wide">
            <span>Page introduction</span>
            <textarea
              maxLength={500}
              value={page.intro ?? ''}
              onChange={(event) =>
                updatePage((target) => {
                  target.intro = event.target.value || undefined;
                })
              }
            />
          </label>
          <label>
            <span>Page hero image</span>
            <select
              value={page.heroMediaId ?? ''}
              onChange={(event) =>
                updatePage((target) => {
                  target.heroMediaId = event.target.value || undefined;
                })
              }
            >
              <option value="">No hero image</option>
              {document.media.map((media) => (
                <option value={media.id} key={media.id}>
                  {media.alt || media.sourcePath}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Browser title</span>
            <input
              required
              maxLength={70}
              value={page.metadata.title}
              onChange={(event) =>
                updatePage((target) => {
                  target.metadata.title = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>Search description</span>
            <textarea
              required
              maxLength={180}
              value={page.metadata.description}
              onChange={(event) =>
                updatePage((target) => {
                  target.metadata.description = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>Social sharing image</span>
            <select
              value={page.metadata.ogImageMediaId ?? ''}
              onChange={(event) =>
                updatePage((target) => {
                  target.metadata.ogImageMediaId = event.target.value || undefined;
                })
              }
            >
              <option value="">Use site default</option>
              {document.media.map((media) => (
                <option value={media.id} key={media.id}>
                  {media.alt || media.sourcePath}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
    </section>
  );
}
