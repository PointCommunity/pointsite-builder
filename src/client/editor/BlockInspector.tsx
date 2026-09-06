import type { ReactNode } from 'react';
import type { SiteDocument, SiteElement } from '../../site-kit/types';

function Text({
  label,
  value,
  onChange,
  area = false,
}: {
  label: string;
  value?: string;
  onChange: (value: string | undefined) => void;
  area?: boolean;
}) {
  const control = area ? (
    <textarea value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)} />
  ) : (
    <input value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)} />
  );
  return (
    <label className="inspector-field">
      <span>{label}</span>
      {control}
    </label>
  );
}

function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { label: string; value: T }[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="inspector-field">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => {
          const next = options.find((option) => String(option.value) === event.target.value);
          if (next) onChange(next.value);
        }}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Media({
  label,
  value,
  document,
  optional = false,
  onChange,
}: {
  label: string;
  value?: string;
  document: SiteDocument;
  optional?: boolean;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label className="inspector-field">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
        {optional ? <option value="">No image</option> : null}
        {document.media.map((item) => (
          <option key={item.id} value={item.id}>
            {item.alt || item.sourcePath.split('/').at(-1)}
          </option>
        ))}
      </select>
    </label>
  );
}

type Action = Extract<SiteElement, { type: 'hero' }>['actions'][number];
type RichNode = Extract<SiteElement, { type: 'richText' }>['content'][number];
function ActionEditor({
  action,
  onChange,
}: {
  action: Action;
  onChange: (action: Action) => void;
}) {
  return (
    <div className="inspector-grid">
      <Text
        label="Button label"
        value={action.label}
        onChange={(label) => label && onChange({ ...action, label })}
      />
      <Text
        label="Button link"
        value={action.href}
        onChange={(href) => href && onChange({ ...action, href })}
      />
      <Select
        label="Button style"
        value={action.style}
        options={[
          { label: 'Primary', value: 'primary' },
          { label: 'Secondary', value: 'secondary' },
          { label: 'Quiet', value: 'quiet' },
        ]}
        onChange={(style) => onChange({ ...action, style })}
      />
    </div>
  );
}

function Row({
  children,
  onRemove,
  removeDisabled = false,
}: {
  children: ReactNode;
  onRemove: () => void;
  removeDisabled?: boolean;
}) {
  return (
    <div className="inspector-row">
      {children}
      <button
        type="button"
        className="button button--danger"
        disabled={removeDisabled}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
}

const surfaceOptions = [
  { label: 'Canvas', value: 'canvas' },
  { label: 'Surface', value: 'surface' },
  { label: 'Primary', value: 'primary' },
] as const;

export function BlockInspector({
  block,
  document,
  onChange,
}: {
  block: SiteElement;
  document: SiteDocument;
  onChange: (block: SiteElement) => void;
}) {
  switch (block.type) {
    case 'hero':
      return (
        <div className="block-inspector">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard hero', value: 'standard' },
              { label: 'Point homepage hero', value: 'homeHero' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Text
            label="Eyebrow"
            value={block.eyebrow}
            onChange={(eyebrow) => onChange({ ...block, eyebrow })}
          />
          <Text
            label="Heading"
            value={block.heading}
            onChange={(heading) => heading && onChange({ ...block, heading })}
          />
          <Text
            label="Body"
            value={block.body}
            area
            onChange={(body) => onChange({ ...block, body })}
          />
          <Media
            label="Background image"
            value={block.mediaId}
            document={document}
            optional
            onChange={(mediaId) => onChange({ ...block, mediaId })}
          />
          <Select
            label="Alignment"
            value={block.align}
            options={[
              { label: 'Left', value: 'left' },
              { label: 'Center', value: 'center' },
            ]}
            onChange={(align) => onChange({ ...block, align })}
          />
          <Select
            label="Background"
            value={block.surface}
            options={[
              { label: 'Canvas', value: 'canvas' },
              { label: 'Primary', value: 'primary' },
              { label: 'Image', value: 'image' },
            ]}
            onChange={(surface) => onChange({ ...block, surface })}
          />
          <fieldset className="inspector-group">
            <legend>Buttons</legend>
            {block.actions.map((action, index) => (
              <Row
                key={`${action.href}-${index}`}
                onRemove={() =>
                  onChange({ ...block, actions: block.actions.filter((_, item) => item !== index) })
                }
              >
                <ActionEditor
                  action={action}
                  onChange={(next) =>
                    onChange({
                      ...block,
                      actions: block.actions.map((item, itemIndex) =>
                        itemIndex === index ? next : item,
                      ),
                    })
                  }
                />
              </Row>
            ))}
            <button
              type="button"
              className="button"
              disabled={block.actions.length >= 2}
              onClick={() =>
                onChange({
                  ...block,
                  actions: [...block.actions, { label: 'Learn more', href: '/', style: 'primary' }],
                })
              }
            >
              Add button
            </button>
          </fieldset>
        </div>
      );
    case 'heading':
      return (
        <div className="block-inspector inspector-grid">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard heading', value: 'standard' },
              { label: 'Point homepage introduction', value: 'homeIntro' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Text
            label="Eyebrow"
            value={block.eyebrow}
            onChange={(eyebrow) => onChange({ ...block, eyebrow })}
          />
          <Text
            label="Heading"
            value={block.text}
            onChange={(text) => text && onChange({ ...block, text })}
          />
          <Select
            label="Level"
            value={block.level}
            options={[
              { label: 'Heading 2', value: 2 },
              { label: 'Heading 3', value: 3 },
              { label: 'Heading 4', value: 4 },
            ]}
            onChange={(level) => onChange({ ...block, level })}
          />
          <Select
            label="Alignment"
            value={block.align}
            options={[
              { label: 'Left', value: 'left' },
              { label: 'Center', value: 'center' },
            ]}
            onChange={(align) => onChange({ ...block, align })}
          />
          <Select
            label="Width"
            value={block.width}
            options={[
              { label: 'Narrow', value: 'narrow' },
              { label: 'Wide', value: 'wide' },
            ]}
            onChange={(width) => onChange({ ...block, width })}
          />
          <Text
            label="Supporting text"
            value={block.supportingText}
            area
            onChange={(supportingText) => onChange({ ...block, supportingText })}
          />
          <fieldset className="inspector-group">
            <legend>Buttons</legend>
            {(block.actions ?? []).map((action, index) => (
              <Row
                key={`${action.href}-${index}`}
                onRemove={() =>
                  onChange({
                    ...block,
                    actions: block.actions?.filter((_, item) => item !== index),
                  })
                }
              >
                <ActionEditor
                  action={action}
                  onChange={(next) =>
                    onChange({
                      ...block,
                      actions: block.actions?.map((item, itemIndex) =>
                        itemIndex === index ? next : item,
                      ),
                    })
                  }
                />
              </Row>
            ))}
            <button
              type="button"
              className="button"
              disabled={(block.actions?.length ?? 0) >= 2}
              onClick={() =>
                onChange({
                  ...block,
                  actions: [
                    ...(block.actions ?? []),
                    { label: 'Learn more', href: '/', style: 'primary' },
                  ],
                })
              }
            >
              Add button
            </button>
          </fieldset>
        </div>
      );
    case 'richText':
      return (
        <div className="block-inspector">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard text', value: 'standard' },
              { label: 'Point editorial section', value: 'prose' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Text
            label="Eyebrow"
            value={block.eyebrow}
            onChange={(eyebrow) => onChange({ ...block, eyebrow })}
          />
          <Text
            label="Section heading"
            value={block.heading}
            onChange={(heading) => onChange({ ...block, heading })}
          />
          <p className="field-help">Use one content item per paragraph, list, quote, or link.</p>
          {block.content.map((node, index) => (
            <Row
              key={`${node.type}-${index}`}
              removeDisabled={block.content.length === 1}
              onRemove={() =>
                onChange({ ...block, content: block.content.filter((_, item) => item !== index) })
              }
            >
              <Select
                label="Content type"
                value={node.type}
                options={[
                  { label: 'Paragraph', value: 'paragraph' },
                  { label: 'Bulleted list', value: 'bulletedList' },
                  { label: 'Numbered list', value: 'numberedList' },
                  { label: 'Quote', value: 'quote' },
                  { label: 'Link', value: 'link' },
                ]}
                onChange={(type) => {
                  const next: RichNode =
                    type === 'paragraph'
                      ? { type, children: [{ text: 'New paragraph' }] }
                      : type === 'bulletedList' || type === 'numberedList'
                        ? { type, items: ['New item'] }
                        : type === 'quote'
                          ? { type, text: 'New quote' }
                          : { type, text: 'Link text', href: '/' };
                  onChange({
                    ...block,
                    content: block.content.map((item, itemIndex) =>
                      itemIndex === index ? next : item,
                    ),
                  });
                }}
              />
              {node.type === 'paragraph' ? (
                <Text
                  label="Paragraph"
                  value={node.children.map((child) => child.text).join('')}
                  area
                  onChange={(text) =>
                    text &&
                    onChange({
                      ...block,
                      content: block.content.map((item, itemIndex) =>
                        itemIndex === index ? { type: 'paragraph', children: [{ text }] } : item,
                      ),
                    })
                  }
                />
              ) : null}
              {node.type === 'bulletedList' || node.type === 'numberedList' ? (
                <Text
                  label="Items (one per line)"
                  value={node.items.join('\n')}
                  area
                  onChange={(value) =>
                    value &&
                    onChange({
                      ...block,
                      content: block.content.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...node, items: value.split('\n').filter(Boolean) }
                          : item,
                      ),
                    })
                  }
                />
              ) : null}
              {node.type === 'quote' ? (
                <>
                  <Text
                    label="Quote"
                    value={node.text}
                    area
                    onChange={(text) =>
                      text &&
                      onChange({
                        ...block,
                        content: block.content.map((item, itemIndex) =>
                          itemIndex === index ? { ...node, text } : item,
                        ),
                      })
                    }
                  />
                  <Text
                    label="Attribution"
                    value={node.attribution}
                    onChange={(attribution) =>
                      onChange({
                        ...block,
                        content: block.content.map((item, itemIndex) =>
                          itemIndex === index ? { ...node, attribution } : item,
                        ),
                      })
                    }
                  />
                </>
              ) : null}
              {node.type === 'link' ? (
                <>
                  <Text
                    label="Link text"
                    value={node.text}
                    onChange={(text) =>
                      text &&
                      onChange({
                        ...block,
                        content: block.content.map((item, itemIndex) =>
                          itemIndex === index ? { ...node, text } : item,
                        ),
                      })
                    }
                  />
                  <Text
                    label="Link destination"
                    value={node.href}
                    onChange={(href) =>
                      href &&
                      onChange({
                        ...block,
                        content: block.content.map((item, itemIndex) =>
                          itemIndex === index ? { ...node, href } : item,
                        ),
                      })
                    }
                  />
                </>
              ) : null}
            </Row>
          ))}
          <button
            type="button"
            className="button"
            disabled={block.content.length >= 100}
            onClick={() =>
              onChange({
                ...block,
                content: [
                  ...block.content,
                  { type: 'paragraph', children: [{ text: 'New paragraph' }] },
                ],
              })
            }
          >
            Add content
          </button>
        </div>
      );
    case 'image':
      return (
        <div className="block-inspector inspector-grid">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard image', value: 'standard' },
              { label: 'Point wide photo', value: 'wide' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Media
            label="Image"
            value={block.mediaId}
            document={document}
            onChange={(mediaId) => mediaId && onChange({ ...block, mediaId })}
          />
          <Text
            label="Alternative text"
            value={block.alt}
            onChange={(alt) => alt && onChange({ ...block, alt })}
          />
          <Select
            label="Aspect ratio"
            value={block.aspect}
            options={[
              { label: 'Natural', value: 'natural' },
              { label: 'Square', value: '1:1' },
              { label: '4:3', value: '4:3' },
              { label: '16:9', value: '16:9' },
            ]}
            onChange={(aspect) => onChange({ ...block, aspect })}
          />
          <Select
            label="Image fit"
            value={block.fit}
            options={[
              { label: 'Cover', value: 'cover' },
              { label: 'Contain', value: 'contain' },
            ]}
            onChange={(fit) => onChange({ ...block, fit })}
          />
          <Text
            label="Caption"
            value={block.caption}
            onChange={(caption) => onChange({ ...block, caption })}
          />
        </div>
      );
    case 'mediaEmbed':
      return (
        <div className="block-inspector inspector-grid">
          <label className="inspector-field">
            <span>Linked media</span>
            <select
              value={block.linkedMediaId}
              onChange={(event) => onChange({ ...block, linkedMediaId: event.target.value })}
            >
              {document.linkedMedia.length === 0 ? (
                <option value={block.linkedMediaId}>Add linked media in Library first</option>
              ) : null}
              {document.linkedMedia.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName} ({item.type === 'youtube' ? 'YouTube' : item.type})
                </option>
              ))}
            </select>
          </label>
          <Select
            label="Aspect ratio"
            value={block.aspect}
            options={[
              { label: 'Natural', value: 'natural' },
              { label: 'Square', value: '1:1' },
              { label: '4:3', value: '4:3' },
              { label: '16:9', value: '16:9' },
            ]}
            onChange={(aspect) => onChange({ ...block, aspect })}
          />
          <Select
            label="Media fit"
            value={block.fit}
            options={[
              { label: 'Cover', value: 'cover' },
              { label: 'Contain', value: 'contain' },
            ]}
            onChange={(fit) => onChange({ ...block, fit })}
          />
          <Text
            label="Caption override"
            value={block.caption}
            onChange={(caption) => onChange({ ...block, caption })}
          />
        </div>
      );
    case 'splitFeature':
      return (
        <div className="block-inspector inspector-grid">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard split', value: 'standard' },
              { label: 'Point photo banner', value: 'photoBanner' },
              { label: 'Point image and text', value: 'splitFeature' },
              { label: 'Point content image split', value: 'imageSplit' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Text
            label="Eyebrow"
            value={block.eyebrow}
            onChange={(eyebrow) => onChange({ ...block, eyebrow })}
          />
          <Text
            label="Heading"
            value={block.heading}
            onChange={(heading) => heading && onChange({ ...block, heading })}
          />
          <Text
            label="Body"
            value={block.body}
            area
            onChange={(body) => body && onChange({ ...block, body })}
          />
          <Text
            label="Small note"
            value={block.note}
            area
            onChange={(note) => onChange({ ...block, note })}
          />
          <Media
            label="Image"
            value={block.mediaId}
            document={document}
            onChange={(mediaId) => mediaId && onChange({ ...block, mediaId })}
          />
          <Text
            label="Image alternative text"
            value={block.mediaAlt}
            onChange={(mediaAlt) => onChange({ ...block, mediaAlt })}
          />
          {block.variant !== 'photoBanner' ? (
            <>
              <Select
                label="Image side"
                value={block.mediaSide}
                options={[
                  { label: 'Left', value: 'left' },
                  { label: 'Right', value: 'right' },
                ]}
                onChange={(mediaSide) => onChange({ ...block, mediaSide })}
              />
              <Select
                label="Proportion"
                value={block.proportion}
                options={[
                  { label: 'Half', value: 'half' },
                  { label: 'Image wide', value: 'mediaWide' },
                  { label: 'Content wide', value: 'contentWide' },
                ]}
                onChange={(proportion) => onChange({ ...block, proportion })}
              />
            </>
          ) : null}
          <Select
            label="Vertical alignment"
            value={block.align}
            options={[
              { label: 'Start', value: 'start' },
              { label: 'Center', value: 'center' },
            ]}
            onChange={(align) => onChange({ ...block, align })}
          />
          {block.variant !== 'photoBanner' ? (
            <Select
              label="Background"
              value={block.surface}
              options={surfaceOptions}
              onChange={(surface) => onChange({ ...block, surface })}
            />
          ) : null}
          <Text
            label="Callout label"
            value={block.calloutLabel}
            onChange={(calloutLabel) => onChange({ ...block, calloutLabel })}
          />
          <Text
            label="Callout value"
            value={block.calloutValue}
            onChange={(calloutValue) => onChange({ ...block, calloutValue })}
          />
          <fieldset className="inspector-group">
            <legend>Optional button</legend>
            {block.action ? (
              <Row onRemove={() => onChange({ ...block, action: undefined })}>
                <ActionEditor
                  action={block.action}
                  onChange={(action) => onChange({ ...block, action })}
                />
              </Row>
            ) : (
              <button
                type="button"
                className="button"
                onClick={() =>
                  onChange({
                    ...block,
                    action: { label: 'Learn more', href: '/', style: 'primary' },
                  })
                }
              >
                Add button
              </button>
            )}
          </fieldset>
        </div>
      );
    case 'cta':
      return (
        <div className="block-inspector inspector-grid">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard call to action', value: 'standard' },
              { label: 'Point wide callout', value: 'rental' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Text
            label="Eyebrow"
            value={block.eyebrow}
            onChange={(eyebrow) => onChange({ ...block, eyebrow })}
          />
          <Text
            label="Heading"
            value={block.heading}
            onChange={(heading) => heading && onChange({ ...block, heading })}
          />
          <Text
            label="Body"
            value={block.body}
            area
            onChange={(body) => onChange({ ...block, body })}
          />
          <Select
            label="Background"
            value={block.surface}
            options={surfaceOptions}
            onChange={(surface) => onChange({ ...block, surface })}
          />
          <ActionEditor
            action={block.action}
            onChange={(action) => onChange({ ...block, action })}
          />
        </div>
      );
    case 'cards':
      return (
        <div className="block-inspector">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard cards', value: 'standard' },
              { label: 'Point split editorial', value: 'splitEditorial' },
              {
                label: 'Point split editorial on warm background',
                value: 'splitEditorialTone',
              },
              { label: 'Point identity columns', value: 'identity' },
              { label: 'Point beliefs list', value: 'beliefs' },
              { label: 'Point neighborhood groups', value: 'groups' },
              { label: 'Point giving options', value: 'giving' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          {block.variant !== 'splitEditorial' && block.variant !== 'splitEditorialTone' ? (
            <>
              <Text
                label="Eyebrow"
                value={block.eyebrow}
                onChange={(eyebrow) => onChange({ ...block, eyebrow })}
              />
              <Text
                label="Section heading"
                value={block.heading}
                onChange={(heading) => onChange({ ...block, heading })}
              />
            </>
          ) : null}
          {block.variant !== 'beliefs' ? (
            <Select
              label="Columns"
              value={block.columns}
              options={[
                { label: '2', value: 2 },
                { label: '3', value: 3 },
                { label: '4', value: 4 },
              ]}
              onChange={(columns) => onChange({ ...block, columns })}
            />
          ) : null}
          <fieldset className="inspector-group">
            <legend>Cards</legend>
            {block.items.map((item, index) => (
              <Row
                key={`${item.title}-${index}`}
                removeDisabled={block.items.length === 1}
                onRemove={() =>
                  onChange({
                    ...block,
                    items: block.items.filter((_, itemIndex) => itemIndex !== index),
                  })
                }
              >
                <Text
                  label="Eyebrow"
                  value={item.eyebrow}
                  onChange={(eyebrow) =>
                    onChange({
                      ...block,
                      items: block.items.map((candidate, itemIndex) =>
                        itemIndex === index ? { ...candidate, eyebrow } : candidate,
                      ),
                    })
                  }
                />
                <Text
                  label="Title"
                  value={item.title}
                  onChange={(title) =>
                    title &&
                    onChange({
                      ...block,
                      items: block.items.map((candidate, itemIndex) =>
                        itemIndex === index ? { ...candidate, title } : candidate,
                      ),
                    })
                  }
                />
                <Text
                  label="Body"
                  value={item.body}
                  area
                  onChange={(body) =>
                    body &&
                    onChange({
                      ...block,
                      items: block.items.map((candidate, itemIndex) =>
                        itemIndex === index ? { ...candidate, body } : candidate,
                      ),
                    })
                  }
                />
                <Text
                  label="Supporting text"
                  value={item.supportingText}
                  onChange={(supportingText) =>
                    onChange({
                      ...block,
                      items: block.items.map((candidate, itemIndex) =>
                        itemIndex === index ? { ...candidate, supportingText } : candidate,
                      ),
                    })
                  }
                />
                <Media
                  label="Image"
                  value={item.mediaId}
                  document={document}
                  optional
                  onChange={(mediaId) =>
                    onChange({
                      ...block,
                      items: block.items.map((candidate, itemIndex) =>
                        itemIndex === index ? { ...candidate, mediaId } : candidate,
                      ),
                    })
                  }
                />
                <Text
                  label="Image alternative text"
                  value={item.mediaAlt}
                  onChange={(mediaAlt) =>
                    onChange({
                      ...block,
                      items: block.items.map((candidate, itemIndex) =>
                        itemIndex === index ? { ...candidate, mediaAlt } : candidate,
                      ),
                    })
                  }
                />
                <Text
                  label="Link"
                  value={item.href}
                  onChange={(href) =>
                    onChange({
                      ...block,
                      items: block.items.map((candidate, itemIndex) =>
                        itemIndex === index ? { ...candidate, href } : candidate,
                      ),
                    })
                  }
                />
              </Row>
            ))}
            <button
              type="button"
              className="button"
              disabled={block.items.length >= 12}
              onClick={() =>
                onChange({
                  ...block,
                  items: [...block.items, { title: 'New card', body: 'Add a description.' }],
                })
              }
            >
              Add card
            </button>
          </fieldset>
        </div>
      );
    case 'people':
      return (
        <div className="block-inspector inspector-grid">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard people', value: 'standard' },
              { label: 'Point leadership grid', value: 'leadership' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Text
            label="Section heading"
            value={block.heading}
            onChange={(heading) => onChange({ ...block, heading })}
          />
          <Select
            label="Layout"
            value={block.layout}
            options={[
              { label: 'Grid', value: 'grid' },
              { label: 'Featured', value: 'featured' },
            ]}
            onChange={(layout) => onChange({ ...block, layout })}
          />
          <fieldset className="inspector-group">
            <legend>People to show</legend>
            {document.collections.people.map((person) => (
              <label className="inspector-check" key={person.id}>
                <input
                  type="checkbox"
                  checked={block.personIds.includes(person.id)}
                  onChange={(event) =>
                    onChange({
                      ...block,
                      personIds: event.target.checked
                        ? [...block.personIds, person.id]
                        : block.personIds.filter((id) => id !== person.id),
                    })
                  }
                />
                <span>{person.name}</span>
              </label>
            ))}
          </fieldset>
        </div>
      );
    case 'faq':
      return (
        <div className="block-inspector">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard questions', value: 'standard' },
              { label: 'Point questions section', value: 'groups' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Text
            label="Eyebrow"
            value={block.eyebrow}
            onChange={(eyebrow) => onChange({ ...block, eyebrow })}
          />
          <Text
            label="Section heading"
            value={block.heading}
            onChange={(heading) => onChange({ ...block, heading })}
          />
          <fieldset className="inspector-group">
            <legend>Questions</legend>
            {block.items.map((item, index) => (
              <Row
                key={`${item.question}-${index}`}
                removeDisabled={block.items.length === 1}
                onRemove={() =>
                  onChange({
                    ...block,
                    items: block.items.filter((_, itemIndex) => itemIndex !== index),
                  })
                }
              >
                <Text
                  label="Question"
                  value={item.question}
                  onChange={(question) =>
                    question &&
                    onChange({
                      ...block,
                      items: block.items.map((candidate, itemIndex) =>
                        itemIndex === index ? { ...candidate, question } : candidate,
                      ),
                    })
                  }
                />
                <Text
                  label="Answer"
                  value={item.answer}
                  area
                  onChange={(answer) =>
                    answer &&
                    onChange({
                      ...block,
                      items: block.items.map((candidate, itemIndex) =>
                        itemIndex === index ? { ...candidate, answer } : candidate,
                      ),
                    })
                  }
                />
                <label className="inspector-check">
                  <input
                    type="checkbox"
                    checked={item.initiallyOpen ?? false}
                    onChange={(event) =>
                      onChange({
                        ...block,
                        items: block.items.map((candidate, itemIndex) =>
                          itemIndex === index
                            ? { ...candidate, initiallyOpen: event.target.checked || undefined }
                            : candidate,
                        ),
                      })
                    }
                  />
                  <span>Open initially</span>
                </label>
              </Row>
            ))}
            <button
              type="button"
              className="button"
              disabled={block.items.length >= 30}
              onClick={() =>
                onChange({
                  ...block,
                  items: [...block.items, { question: 'New question', answer: 'Add an answer.' }],
                })
              }
            >
              Add question
            </button>
          </fieldset>
        </div>
      );
    case 'form':
      return (
        <div className="block-inspector inspector-grid">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard form section', value: 'standard' },
              { label: 'Point form panel', value: 'panel' },
              { label: 'Point standalone form', value: 'standalone' },
              { label: 'Point contact and form', value: 'contact' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <label className="inspector-field">
            <span>Form</span>
            <select
              value={block.formId}
              onChange={(event) => onChange({ ...block, formId: event.target.value })}
            >
              {document.forms.map((form) => (
                <option value={form.id} key={form.id}>
                  {form.name}
                </option>
              ))}
            </select>
          </label>
          <Text
            label="Heading"
            value={block.heading}
            onChange={(heading) => onChange({ ...block, heading })}
          />
          <Text
            label="Eyebrow"
            value={block.eyebrow}
            onChange={(eyebrow) => onChange({ ...block, eyebrow })}
          />
          <Text
            label="Contact details"
            value={block.body}
            area
            onChange={(body) => onChange({ ...block, body })}
          />
          <Text
            label="Supporting text"
            value={block.supportingText}
            area
            onChange={(supportingText) => onChange({ ...block, supportingText })}
          />
          <Text
            label="Supporting link label"
            value={block.linkLabel}
            onChange={(linkLabel) => onChange({ ...block, linkLabel })}
          />
          <Text
            label="Supporting link destination"
            value={block.linkHref}
            onChange={(linkHref) => onChange({ ...block, linkHref })}
          />
        </div>
      );
    case 'map':
      return (
        <div className="block-inspector inspector-grid">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard map', value: 'standard' },
              { label: 'Point gathering section', value: 'gathering' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Text
            label="Eyebrow"
            value={block.eyebrow}
            onChange={(eyebrow) => onChange({ ...block, eyebrow })}
          />
          <Text
            label="Section heading"
            value={block.heading}
            onChange={(heading) => onChange({ ...block, heading })}
          />
          <Text
            label="Details"
            value={block.body}
            area
            onChange={(body) => onChange({ ...block, body })}
          />
          <Text
            label="Title"
            value={block.title}
            onChange={(title) => title && onChange({ ...block, title })}
          />
          <Text
            label="Location or search"
            value={block.query}
            onChange={(query) => query && onChange({ ...block, query })}
          />
        </div>
      );
    case 'divider':
      return (
        <div className="block-inspector">
          <Select
            label="Divider style"
            value={block.style}
            options={[
              { label: 'Line', value: 'line' },
              { label: 'Space', value: 'space' },
            ]}
            onChange={(style) => onChange({ ...block, style })}
          />
        </div>
      );
    case 'spacer':
      return (
        <div className="block-inspector">
          <Select
            label="Space size"
            value={block.size}
            options={[
              { label: 'Small', value: 'small' },
              { label: 'Medium', value: 'medium' },
              { label: 'Large', value: 'large' },
            ]}
            onChange={(size) => onChange({ ...block, size })}
          />
        </div>
      );
    case 'text':
      return (
        <div className="block-inspector inspector-grid">
          <Text
            label="Text"
            value={block.text}
            area
            onChange={(text) => text && onChange({ ...block, text })}
          />
          <Select
            label="Text style"
            value={block.style}
            options={[
              { label: 'Body', value: 'body' },
              { label: 'Lead', value: 'lead' },
              { label: 'Eyebrow', value: 'eyebrow' },
              { label: 'Small', value: 'small' },
            ]}
            onChange={(style) => onChange({ ...block, style })}
          />
          <Select
            label="Text alignment"
            value={block.align}
            options={[
              { label: 'Left', value: 'left' },
              { label: 'Center', value: 'center' },
            ]}
            onChange={(align) => onChange({ ...block, align })}
          />
        </div>
      );
    case 'button':
      return (
        <div className="block-inspector inspector-grid">
          <Text
            label="Button label"
            value={block.label}
            onChange={(label) => label && onChange({ ...block, label })}
          />
          <Text
            label="Button link"
            value={block.href}
            onChange={(href) => href && onChange({ ...block, href })}
          />
          <Select
            label="Button style"
            value={block.style}
            options={[
              { label: 'Primary', value: 'primary' },
              { label: 'Secondary', value: 'secondary' },
              { label: 'Quiet', value: 'quiet' },
            ]}
            onChange={(style) => onChange({ ...block, style })}
          />
          <Select
            label="Button width"
            value={block.width}
            options={[
              { label: 'Fit label', value: 'fit' },
              { label: 'Fill element', value: 'full' },
            ]}
            onChange={(width) => onChange({ ...block, width })}
          />
          <Select
            label="Button alignment"
            value={block.align}
            options={[
              { label: 'Left', value: 'left' },
              { label: 'Center', value: 'center' },
              { label: 'Right', value: 'right' },
            ]}
            onChange={(align) => onChange({ ...block, align })}
          />
        </div>
      );
  }
}
