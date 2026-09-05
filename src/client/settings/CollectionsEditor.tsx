import type { ReactNode } from 'react';
import type { SiteDocument } from '../../site-kit/types';

type Collections = SiteDocument['collections'];
const replace = <T,>(items: T[], index: number, value: T) =>
  items.map((item, itemIndex) => (itemIndex === index ? value : item));

function CollectionItem({
  title,
  children,
  onRemove,
}: {
  title: string;
  children: ReactNode;
  onRemove: () => void;
}) {
  return (
    <fieldset className="settings-list__item settings-list__item--stacked">
      <legend>{title}</legend>
      <div className="field-grid">{children}</div>
      <button type="button" className="button button--danger" onClick={onRemove}>
        Remove
      </button>
    </fieldset>
  );
}

function MediaSelect({
  document,
  value,
  onChange,
}: {
  document: SiteDocument;
  value?: string;
  onChange: (value?: string) => void;
}) {
  return (
    <label>
      <span>Photo</span>
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">No photo</option>
        {document.media.map((media) => (
          <option key={media.id} value={media.id}>
            {media.alt || media.sourcePath}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CollectionsEditor({
  document,
  onChange,
}: {
  document: SiteDocument;
  onChange: (collections: Collections) => void;
}) {
  const { collections } = document;
  return (
    <section className="settings-section" aria-labelledby="collections-title">
      <div className="settings-heading">
        <div>
          <h3 id="collections-title">Reusable content</h3>
          <p>Update a person, belief, group, or event once and reuse it across pages.</p>
        </div>
      </div>
      <details open>
        <summary>People ({collections.people.length})</summary>
        <div className="settings-list collection-list">
          {collections.people.map((person, index) => (
            <CollectionItem
              key={person.id}
              title={person.name}
              onRemove={() =>
                onChange({
                  ...collections,
                  people: collections.people.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              <label>
                <span>Name</span>
                <input
                  required
                  value={person.name}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      people: replace(collections.people, index, {
                        ...person,
                        name: event.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label>
                <span>Role</span>
                <input
                  required
                  value={person.role}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      people: replace(collections.people, index, {
                        ...person,
                        role: event.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label className="field-wide">
                <span>Biography</span>
                <textarea
                  required
                  value={person.bio}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      people: replace(collections.people, index, {
                        ...person,
                        bio: event.target.value,
                      }),
                    })
                  }
                />
              </label>
              <MediaSelect
                document={document}
                value={person.mediaId}
                onChange={(mediaId) =>
                  onChange({
                    ...collections,
                    people: replace(collections.people, index, { ...person, mediaId }),
                  })
                }
              />
              <label>
                <span>Photo alternative text</span>
                <input
                  value={person.mediaAlt ?? ''}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      people: replace(collections.people, index, {
                        ...person,
                        mediaAlt: event.target.value || undefined,
                      }),
                    })
                  }
                />
              </label>
            </CollectionItem>
          ))}
        </div>
        <button
          type="button"
          className="button"
          onClick={() =>
            onChange({
              ...collections,
              people: [
                ...collections.people,
                {
                  id: crypto.randomUUID(),
                  name: 'New person',
                  role: 'Team member',
                  bio: 'Add a short biography.',
                },
              ],
            })
          }
        >
          Add person
        </button>
      </details>
      <details>
        <summary>Beliefs ({collections.beliefs.length})</summary>
        <div className="settings-list collection-list">
          {collections.beliefs.map((belief, index) => (
            <CollectionItem
              key={belief.id}
              title={belief.title}
              onRemove={() =>
                onChange({
                  ...collections,
                  beliefs: collections.beliefs.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              <label>
                <span>Title</span>
                <input
                  required
                  value={belief.title}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      beliefs: replace(collections.beliefs, index, {
                        ...belief,
                        title: event.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label className="field-wide">
                <span>Body</span>
                <textarea
                  required
                  value={belief.body}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      beliefs: replace(collections.beliefs, index, {
                        ...belief,
                        body: event.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label className="field-wide">
                <span>References</span>
                <input
                  value={belief.references ?? ''}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      beliefs: replace(collections.beliefs, index, {
                        ...belief,
                        references: event.target.value || undefined,
                      }),
                    })
                  }
                />
              </label>
            </CollectionItem>
          ))}
        </div>
        <button
          type="button"
          className="button"
          onClick={() =>
            onChange({
              ...collections,
              beliefs: [
                ...collections.beliefs,
                { id: crypto.randomUUID(), title: 'New belief', body: 'Add the full text.' },
              ],
            })
          }
        >
          Add belief
        </button>
      </details>
      <details>
        <summary>Neighborhood groups ({collections.groups.length})</summary>
        <div className="settings-list collection-list">
          {collections.groups.map((group, index) => (
            <CollectionItem
              key={group.id}
              title={group.name}
              onRemove={() =>
                onChange({
                  ...collections,
                  groups: collections.groups.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              <label>
                <span>Name</span>
                <input
                  required
                  value={group.name}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      groups: replace(collections.groups, index, {
                        ...group,
                        name: event.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label>
                <span>Status</span>
                <select
                  value={group.status}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      groups: replace(collections.groups, index, {
                        ...group,
                        status: event.target.value as typeof group.status,
                      }),
                    })
                  }
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
              <label className="field-wide">
                <span>Description</span>
                <textarea
                  required
                  value={group.description}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      groups: replace(collections.groups, index, {
                        ...group,
                        description: event.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label>
                <span>Schedule</span>
                <input
                  value={group.schedule ?? ''}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      groups: replace(collections.groups, index, {
                        ...group,
                        schedule: event.target.value || undefined,
                      }),
                    })
                  }
                />
              </label>
              <label>
                <span>Location</span>
                <input
                  value={group.location ?? ''}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      groups: replace(collections.groups, index, {
                        ...group,
                        location: event.target.value || undefined,
                      }),
                    })
                  }
                />
              </label>
              <label>
                <span>Leaders</span>
                <input
                  value={group.leaders ?? ''}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      groups: replace(collections.groups, index, {
                        ...group,
                        leaders: event.target.value || undefined,
                      }),
                    })
                  }
                />
              </label>
              <label>
                <span>Contact email</span>
                <input
                  type="email"
                  value={group.contactEmail ?? ''}
                  onChange={(event) =>
                    onChange({
                      ...collections,
                      groups: replace(collections.groups, index, {
                        ...group,
                        contactEmail: event.target.value || undefined,
                      }),
                    })
                  }
                />
              </label>
            </CollectionItem>
          ))}
        </div>
        <button
          type="button"
          className="button"
          onClick={() =>
            onChange({
              ...collections,
              groups: [
                ...collections.groups,
                {
                  id: crypto.randomUUID(),
                  name: 'New group',
                  description: 'Add a description.',
                  status: 'active',
                },
              ],
            })
          }
        >
          Add group
        </button>
      </details>
      <details>
        <summary>Events ({collections.events.length})</summary>
        <div className="settings-list collection-list">
          {collections.events.map((event, index) => (
            <CollectionItem
              key={event.id}
              title={event.name}
              onRemove={() =>
                onChange({
                  ...collections,
                  events: collections.events.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              <label>
                <span>Name</span>
                <input
                  required
                  value={event.name}
                  onChange={(changeEvent) =>
                    onChange({
                      ...collections,
                      events: replace(collections.events, index, {
                        ...event,
                        name: changeEvent.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label>
                <span>Status</span>
                <select
                  value={event.status}
                  onChange={(changeEvent) =>
                    onChange({
                      ...collections,
                      events: replace(collections.events, index, {
                        ...event,
                        status: changeEvent.target.value as typeof event.status,
                      }),
                    })
                  }
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
              <label className="field-wide">
                <span>Description</span>
                <textarea
                  required
                  value={event.description}
                  onChange={(changeEvent) =>
                    onChange({
                      ...collections,
                      events: replace(collections.events, index, {
                        ...event,
                        description: changeEvent.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label>
                <span>Schedule</span>
                <input
                  required
                  value={event.schedule}
                  onChange={(changeEvent) =>
                    onChange({
                      ...collections,
                      events: replace(collections.events, index, {
                        ...event,
                        schedule: changeEvent.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label>
                <span>Location</span>
                <input
                  required
                  value={event.location}
                  onChange={(changeEvent) =>
                    onChange({
                      ...collections,
                      events: replace(collections.events, index, {
                        ...event,
                        location: changeEvent.target.value,
                      }),
                    })
                  }
                />
              </label>
              <label className="field-wide">
                <span>Link</span>
                <input
                  value={event.href ?? ''}
                  onChange={(changeEvent) =>
                    onChange({
                      ...collections,
                      events: replace(collections.events, index, {
                        ...event,
                        href: changeEvent.target.value || undefined,
                      }),
                    })
                  }
                />
              </label>
            </CollectionItem>
          ))}
        </div>
        <button
          type="button"
          className="button"
          onClick={() =>
            onChange({
              ...collections,
              events: [
                ...collections.events,
                {
                  id: crypto.randomUUID(),
                  name: 'New event',
                  description: 'Add a description.',
                  schedule: 'Add a schedule',
                  location: 'Add a location',
                  status: 'active',
                },
              ],
            })
          }
        >
          Add event
        </button>
      </details>
    </section>
  );
}
