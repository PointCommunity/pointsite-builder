import type { NavigationEntry } from '../../site-kit/types';

export function NavigationEditor({
  navigation,
  onChange,
}: {
  navigation: NavigationEntry[];
  onChange: (navigation: NavigationEntry[]) => void;
}) {
  const update = (index: number, change: (item: NavigationEntry) => void) => {
    const next = structuredClone(navigation);
    const item = next[index];
    if (item) change(item);
    onChange(next);
  };
  const move = (index: number, delta: number) => {
    const next = structuredClone(navigation);
    const [item] = next.splice(index, 1);
    if (item) next.splice(index + delta, 0, item);
    onChange(next);
  };
  const add = () =>
    onChange([
      ...navigation,
      { id: crypto.randomUUID(), label: 'New link', href: '/', children: [] },
    ]);
  return (
    <section className="settings-section" aria-labelledby="navigation-title">
      <div className="settings-heading">
        <div>
          <h3 id="navigation-title">Navigation</h3>
          <p>
            These shared links appear in every Navigation element. Optional child links form each
            menu.
          </p>
        </div>
      </div>
      <div className="settings-list">
        {navigation.map((item, index) => (
          <fieldset className="settings-list__item settings-list__item--stacked" key={item.id}>
            <legend>{item.label}</legend>
            <div className="field-grid">
              <label>
                <span>Label</span>
                <input
                  required
                  maxLength={60}
                  value={item.label}
                  onChange={(event) =>
                    update(index, (target) => {
                      target.label = event.target.value;
                    })
                  }
                />
              </label>
              <label>
                <span>Link</span>
                <input
                  required
                  value={item.href}
                  onChange={(event) =>
                    update(index, (target) => {
                      target.href = event.target.value;
                    })
                  }
                />
              </label>
            </div>
            <div className="page-actions">
              <button
                type="button"
                className="button"
                disabled={index === 0}
                onClick={() => move(index, -1)}
                aria-label={`Move ${item.label} earlier`}
              >
                ↑ Earlier
              </button>
              <button
                type="button"
                className="button"
                disabled={index === navigation.length - 1}
                onClick={() => move(index, 1)}
                aria-label={`Move ${item.label} later`}
              >
                ↓ Later
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => onChange(navigation.filter((_, candidate) => candidate !== index))}
              >
                Remove section
              </button>
            </div>
            <fieldset className="settings-fieldset">
              <legend>Child links</legend>
              {item.children.map((child, childIndex) => (
                <div className="inline-editor" key={child.id}>
                  <label>
                    <span>Label</span>
                    <input
                      required
                      maxLength={60}
                      value={child.label}
                      onChange={(event) =>
                        update(index, (target) => {
                          target.children[childIndex].label = event.target.value;
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Link</span>
                    <input
                      required
                      value={child.href}
                      onChange={(event) =>
                        update(index, (target) => {
                          target.children[childIndex].href = event.target.value;
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() =>
                      update(index, (target) => {
                        target.children.splice(childIndex, 1);
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button"
                disabled={item.children.length >= 12}
                onClick={() =>
                  update(index, (target) => {
                    target.children.push({
                      id: crypto.randomUUID(),
                      label: 'New child link',
                      href: '/',
                    });
                  })
                }
              >
                Add child link
              </button>
            </fieldset>
          </fieldset>
        ))}
      </div>
      <button type="button" className="button" disabled={navigation.length >= 20} onClick={add}>
        Add navigation section
      </button>
    </section>
  );
}
