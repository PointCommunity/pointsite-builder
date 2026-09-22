import type { ReactNode } from 'react';
import type { SiteDocument, SiteElement } from '../../site-kit/types';
import { LinkDestinationField } from './LinkDestinationField';

function Text({
  label,
  value,
  onChange,
  area = false,
  allowEmpty = false,
}: {
  label: string;
  value?: string;
  onChange: (value: string | undefined) => void;
  area?: boolean;
  allowEmpty?: boolean;
}) {
  const control = area ? (
    <textarea
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || (allowEmpty ? '' : undefined))}
    />
  ) : (
    <input
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || (allowEmpty ? '' : undefined))}
    />
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
  schemaVersion = 11,
}: {
  label: string;
  value: T;
  options: readonly { label: string; value: T }[];
  onChange: (value: T) => void;
  schemaVersion?: number;
}) {
  const visibleOptions =
    schemaVersion >= 12
      ? options.map((option) => ({
          ...option,
          label: option.label.replace(/^Point (.)/, (_, initial: string) => initial.toUpperCase()),
        }))
      : options;
  return (
    <label className="inspector-field">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => {
          const next = visibleOptions.find((option) => String(option.value) === event.target.value);
          if (next) onChange(next.value);
        }}
      >
        {visibleOptions.map((option) => (
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

type FocalPoint = { x: number; y: number };
function FocalFields({
  value,
  onChange,
}: {
  value?: FocalPoint;
  onChange: (value?: FocalPoint) => void;
}) {
  return (
    <fieldset className="inspector-grid">
      <legend>Image crop focus</legend>
      {(['x', 'y'] as const).map((axis) => (
        <label className="inspector-field" key={axis}>
          <span>{axis === 'x' ? 'Horizontal focus (%)' : 'Vertical focus (%)'}</span>
          <input
            type="number"
            min={0}
            max={100}
            value={value?.[axis] ?? 50}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              if (Number.isInteger(next) && next >= 0 && next <= 100)
                onChange({ x: value?.x ?? 50, y: value?.y ?? 50, [axis]: next });
            }}
          />
        </label>
      ))}
      {value ? (
        <button type="button" className="button" onClick={() => onChange(undefined)}>
          Reset crop focus
        </button>
      ) : null}
    </fieldset>
  );
}

type Action = Extract<SiteElement, { type: 'hero' }>['actions'][number];
type RichNode = Extract<SiteElement, { type: 'richText' }>['content'][number];
function ActionEditor({
  action,
  document,
  onChange,
}: {
  action: Action;
  document: SiteDocument;
  onChange: (action: Action) => void;
}) {
  return (
    <div className="inspector-grid">
      <Text
        label="Button label"
        value={action.label}
        allowEmpty={document.schemaVersion >= 12}
        onChange={(label) => label !== undefined && onChange({ ...action, label })}
      />
      <LinkDestinationField
        label="Button link"
        value={action.href}
        pages={document.pages}
        onChange={(href) => onChange({ ...action, href })}
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
  onEditNavigation,
}: {
  block: SiteElement;
  document: SiteDocument;
  onChange: (block: SiteElement) => void;
  onEditNavigation?: (designId: string) => void;
}) {
  switch (block.type) {
    case 'composition':
      return (
        <div className="block-inspector">
          <Text
            label="Group name"
            value={block.name}
            onChange={(name) => onChange({ ...block, name: name ?? '' })}
          />
          <p className="field-help">Drag elements into this group and position them on its grid.</p>
        </div>
      );
    case 'hero':
      return (
        <div className="block-inspector">
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard hero', value: 'standard' },
              { label: 'Point homepage hero', value: 'homeHero' },
              { label: 'Point page hero', value: 'pageHero' },
            ]}
            schemaVersion={document.schemaVersion}
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
            allowEmpty={document.schemaVersion >= 12}
            onChange={(heading) => heading !== undefined && onChange({ ...block, heading })}
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
          {document.schemaVersion >= 12 && block.mediaId ? (
            <FocalFields
              value={block.mediaFocal}
              onChange={(mediaFocal) => onChange({ ...block, mediaFocal })}
            />
          ) : null}
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
                key={index}
                onRemove={() =>
                  onChange({ ...block, actions: block.actions.filter((_, item) => item !== index) })
                }
              >
                <ActionEditor
                  action={action}
                  document={document}
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
            schemaVersion={document.schemaVersion}
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
            allowEmpty={document.schemaVersion >= 12}
            onChange={(text) => text !== undefined && onChange({ ...block, text })}
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
                key={index}
                onRemove={() =>
                  onChange({
                    ...block,
                    actions: block.actions?.filter((_, item) => item !== index),
                  })
                }
              >
                <ActionEditor
                  action={action}
                  document={document}
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
              ...(document.schemaVersion >= 11
                ? [{ label: 'Footer information', value: 'footer' as const }]
                : []),
            ]}
            schemaVersion={document.schemaVersion}
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
          {document.schemaVersion >= 11 ? (
            <Select
              label="Text alignment"
              value={block.align ?? (block.variant === 'footer' ? 'center' : 'left')}
              options={[
                { label: 'Left', value: 'left' },
                { label: 'Center', value: 'center' },
                { label: 'Right', value: 'right' },
              ]}
              onChange={(align) => onChange({ ...block, align })}
            />
          ) : null}
          {block.content.map((node, index) => (
            <Row
              key={index}
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
                  ...(document.schemaVersion >= 11
                    ? [{ label: 'Address', value: 'address' as const }]
                    : []),
                ]}
                onChange={(type) => {
                  const next: RichNode =
                    type === 'paragraph'
                      ? { type, children: [{ text: 'New paragraph' }] }
                      : type === 'bulletedList' || type === 'numberedList'
                        ? { type, items: ['New item'] }
                        : type === 'quote' || type === 'address'
                          ? {
                              type,
                              text: type === 'quote' ? 'New quote' : 'Street\nCity, State ZIP',
                            }
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
                  allowEmpty={document.schemaVersion >= 12}
                  onChange={(text) =>
                    text !== undefined &&
                    onChange({
                      ...block,
                      content: block.content.map((item, itemIndex) =>
                        itemIndex === index ? { type: 'paragraph', children: [{ text }] } : item,
                      ),
                    })
                  }
                />
              ) : null}
              {node.type === 'address' ? (
                <Text
                  label="Address"
                  value={node.text}
                  area
                  allowEmpty={document.schemaVersion >= 12}
                  onChange={(text) =>
                    text !== undefined &&
                    onChange({
                      ...block,
                      content: block.content.map((item, itemIndex) =>
                        itemIndex === index ? { ...node, text } : item,
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
                  allowEmpty={document.schemaVersion >= 12}
                  onChange={(value) =>
                    value !== undefined &&
                    onChange({
                      ...block,
                      content: block.content.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...node, items: value ? value.split('\n').filter(Boolean) : [''] }
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
                    allowEmpty={document.schemaVersion >= 12}
                    onChange={(text) =>
                      text !== undefined &&
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
                    allowEmpty={document.schemaVersion >= 12}
                    onChange={(text) =>
                      text !== undefined &&
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
            schemaVersion={document.schemaVersion}
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
            allowEmpty={document.schemaVersion >= 12}
            onChange={(alt) => alt !== undefined && onChange({ ...block, alt })}
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
              { label: 'Crop to fill', value: 'cover' },
              { label: 'Fit whole image', value: 'contain' },
              ...(document.schemaVersion >= 12
                ? [{ label: 'Stretch', value: 'stretch' as const }]
                : []),
            ]}
            onChange={(fit) => onChange({ ...block, fit })}
          />
          {document.schemaVersion >= 12 ? (
            <FocalFields value={block.focal} onChange={(focal) => onChange({ ...block, focal })} />
          ) : null}
          <Text
            label="Caption"
            value={block.caption}
            onChange={(caption) => onChange({ ...block, caption })}
          />
          {document.schemaVersion >= 12 ? (
            <>
              <label className="inspector-field">
                <span>Link image</span>
                <input
                  type="checkbox"
                  checked={block.href !== undefined}
                  onChange={(event) => {
                    if (event.target.checked)
                      onChange({ ...block, href: document.pages[0]?.route ?? '/' });
                    else {
                      const next = { ...block };
                      delete next.href;
                      onChange(next);
                    }
                  }}
                />
              </label>
              {block.href !== undefined ? (
                <LinkDestinationField
                  label="Image link"
                  value={block.href}
                  pages={document.pages}
                  onChange={(href) => onChange({ ...block, href })}
                />
              ) : null}
            </>
          ) : null}
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
            schemaVersion={document.schemaVersion}
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
            allowEmpty={document.schemaVersion >= 12}
            onChange={(heading) => heading !== undefined && onChange({ ...block, heading })}
          />
          <Text
            label="Body"
            value={block.body}
            area
            allowEmpty={document.schemaVersion >= 12}
            onChange={(body) => body !== undefined && onChange({ ...block, body })}
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
          {document.schemaVersion >= 12 ? (
            <FocalFields
              value={block.mediaFocal}
              onChange={(mediaFocal) => onChange({ ...block, mediaFocal })}
            />
          ) : null}
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
            label="Horizontal alignment"
            value={block.textAlign ?? 'left'}
            options={[
              { label: 'Left', value: 'left' },
              { label: 'Center', value: 'center' },
              { label: 'Right', value: 'right' },
            ]}
            onChange={(textAlign) => onChange({ ...block, textAlign })}
          />
          <Select
            label="Vertical alignment"
            value={block.align}
            options={[
              { label: 'Top', value: 'start' },
              { label: 'Center', value: 'center' },
              { label: 'Bottom', value: 'end' },
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
                  document={document}
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
            schemaVersion={document.schemaVersion}
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
            allowEmpty={document.schemaVersion >= 12}
            onChange={(heading) => heading !== undefined && onChange({ ...block, heading })}
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
            document={document}
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
            schemaVersion={document.schemaVersion}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <p className="inspector-hint">
            Images use 16:9 frames. Missing images reserve the same space when other cards have
            images. Text-only collections have no image frames.
          </p>
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
                key={index}
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
                  allowEmpty={document.schemaVersion >= 12}
                  onChange={(title) =>
                    title !== undefined &&
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
                  allowEmpty={document.schemaVersion >= 12}
                  onChange={(body) =>
                    body !== undefined &&
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
                {document.schemaVersion >= 12 ? (
                  <>
                    <Select
                      label="Image fit"
                      value={item.mediaFit ?? 'contain'}
                      options={[
                        { label: 'Fit whole image', value: 'contain' },
                        { label: 'Crop to fill', value: 'cover' },
                        { label: 'Stretch', value: 'stretch' },
                      ]}
                      onChange={(mediaFit) =>
                        onChange({
                          ...block,
                          items: block.items.map((candidate, itemIndex) =>
                            itemIndex === index ? { ...candidate, mediaFit } : candidate,
                          ),
                        })
                      }
                    />
                    <Select
                      label="Image frame"
                      value={item.mediaFrame ?? 'default'}
                      options={[
                        { label: 'Layout default', value: 'default' },
                        { label: 'Natural', value: 'natural' },
                        { label: 'Portrait 4:5', value: 'portrait' },
                        { label: 'Square 1:1', value: 'square' },
                        { label: 'Landscape 16:9', value: 'landscape' },
                      ]}
                      onChange={(frame) =>
                        onChange({
                          ...block,
                          items: block.items.map((candidate, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...candidate,
                                  mediaFrame: frame === 'default' ? undefined : frame,
                                }
                              : candidate,
                          ),
                        })
                      }
                    />
                  </>
                ) : null}
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
                {document.schemaVersion >= 12 && item.mediaId ? (
                  <FocalFields
                    value={item.mediaFocal}
                    onChange={(mediaFocal) =>
                      onChange({
                        ...block,
                        items: block.items.map((candidate, itemIndex) =>
                          itemIndex === index ? { ...candidate, mediaFocal } : candidate,
                        ),
                      })
                    }
                  />
                ) : null}
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
              { label: 'Standard People', value: 'standard' },
              { label: 'Vertical Grid', value: 'leadership' },
              { label: 'Horizontal Grid', value: 'horizontal' },
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
          <p className="inspector-hint">
            {block.variant === 'horizontal'
              ? '16:9 landscape frames. Photos fill the frame with cropping, without distortion.'
              : block.variant === 'leadership'
                ? '4:5 portrait frames. Photos fill the frame with cropping, without distortion.'
                : '4:5 portrait frames. Whole photos fit without cropping, with background around unused space.'}
          </p>
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
            schemaVersion={document.schemaVersion}
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
                key={index}
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
                  allowEmpty={document.schemaVersion >= 12}
                  onChange={(question) =>
                    question !== undefined &&
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
                  allowEmpty={document.schemaVersion >= 12}
                  onChange={(answer) =>
                    answer !== undefined &&
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
            schemaVersion={document.schemaVersion}
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
                  {form.name || 'Untitled form'}
                </option>
              ))}
            </select>
          </label>
          <Text
            label="Heading"
            value={block.heading}
            allowEmpty={document.schemaVersion >= 12}
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
            schemaVersion={document.schemaVersion}
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
            allowEmpty={document.schemaVersion >= 12}
            onChange={(title) => title !== undefined && onChange({ ...block, title })}
          />
          <Text
            label="Location or search"
            value={block.query}
            allowEmpty={document.schemaVersion >= 12}
            onChange={(query) => query !== undefined && onChange({ ...block, query })}
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
            onChange={(text) =>
              (text !== undefined || document.schemaVersion >= 12) &&
              onChange({ ...block, text: text ?? '' })
            }
          />
          {document.schemaVersion >= 12 ? (
            <Select
              label="Text type"
              value={block.semantic ?? 'p'}
              options={[
                { label: 'Paragraph', value: 'p' },
                { label: 'Heading 1', value: 'h1' },
                { label: 'Heading 2', value: 'h2' },
                { label: 'Heading 3', value: 'h3' },
                { label: 'Heading 4', value: 'h4' },
                { label: 'Heading 5', value: 'h5' },
                { label: 'Heading 6', value: 'h6' },
              ]}
              onChange={(semantic) => onChange({ ...block, semantic })}
            />
          ) : null}
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
            allowEmpty={document.schemaVersion >= 12}
            onChange={(label) => label !== undefined && onChange({ ...block, label })}
          />
          <LinkDestinationField
            label="Button link"
            value={block.href}
            pages={document.pages}
            onChange={(href) => onChange({ ...block, href })}
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
    case 'socialLinks':
      return (
        <div className="block-inspector inspector-grid">
          <Text
            label="Section heading"
            value={block.heading}
            onChange={(heading) => onChange({ ...block, heading })}
          />
          <Select
            label="Layout style"
            value={block.variant ?? 'standard'}
            options={[
              { label: 'Standard', value: 'standard' },
              { label: 'Footer information', value: 'footer' },
            ]}
            onChange={(variant) => onChange({ ...block, variant })}
          />
          <Select
            label="Link appearance"
            value={block.appearance}
            options={[
              { label: 'Icons', value: 'icons' },
              { label: 'Labels', value: 'labels' },
            ]}
            onChange={(appearance) => onChange({ ...block, appearance })}
          />
          <Select
            label="Alignment"
            value={block.align}
            options={[
              { label: 'Left', value: 'left' },
              { label: 'Center', value: 'center' },
              { label: 'Right', value: 'right' },
            ]}
            onChange={(align) => onChange({ ...block, align })}
          />
          {block.links.map((link, index) => (
            <Row
              key={index}
              onRemove={() =>
                onChange({ ...block, links: block.links.filter((_, item) => item !== index) })
              }
            >
              <Select
                label="Social platform"
                value={link.platform}
                options={(['facebook', 'instagram', 'youtube', 'x', 'other'] as const).map(
                  (value) => ({
                    label: value === 'other' ? 'Website' : value[0].toUpperCase() + value.slice(1),
                    value,
                  }),
                )}
                onChange={(platform) =>
                  onChange({
                    ...block,
                    links: block.links.map((item, position) =>
                      position === index ? { ...item, platform } : item,
                    ),
                  })
                }
              />
              <Text
                label="Link label"
                value={link.label}
                allowEmpty={document.schemaVersion >= 12}
                onChange={(label) =>
                  label !== undefined &&
                  onChange({
                    ...block,
                    links: block.links.map((item, position) =>
                      position === index ? { ...item, label } : item,
                    ),
                  })
                }
              />
              <LinkDestinationField
                label="Web address"
                value={link.url}
                pages={document.pages}
                httpsOnly
                onChange={(url) =>
                  onChange({
                    ...block,
                    links: block.links.map((item, position) =>
                      position === index ? { ...item, url } : item,
                    ),
                  })
                }
              />
            </Row>
          ))}
          <button
            type="button"
            className="button"
            disabled={block.links.length >= 12}
            onClick={() =>
              onChange({
                ...block,
                links: [
                  ...block.links,
                  { platform: 'other', label: 'Website', url: 'https://example.com' },
                ],
              })
            }
          >
            Add link
          </button>
        </div>
      );
    case 'navigation':
      return (
        <div className="block-inspector inspector-grid">
          {document.schemaVersion >= 10 ? (
            <Select
              label="Navigation design"
              value={block.navigationDesignId ?? ''}
              options={(document.navigationDesigns ?? []).map((design) => ({
                label: design.name,
                value: design.id,
              }))}
              onChange={(navigationDesignId) => onChange({ ...block, navigationDesignId })}
            />
          ) : null}
          <Text
            label="Navigation label"
            value={block.label}
            allowEmpty={document.schemaVersion >= 12}
            onChange={(label) => label !== undefined && onChange({ ...block, label })}
          />
          <Select
            label="Navigation layout"
            value={block.orientation}
            options={[
              { label: 'Responsive', value: 'responsive' },
              { label: 'Horizontal', value: 'horizontal' },
              { label: 'Vertical', value: 'vertical' },
            ]}
            onChange={(orientation) => onChange({ ...block, orientation })}
          />
          <Select
            label="Navigation alignment"
            value={block.align}
            options={[
              { label: 'Left', value: 'left' },
              { label: 'Center', value: 'center' },
              { label: 'Right', value: 'right' },
            ]}
            onChange={(align) => onChange({ ...block, align })}
          />
          <Select
            label="Navigation background"
            value={block.surface}
            options={[
              { label: 'Transparent', value: 'transparent' },
              { label: 'Canvas', value: 'canvas' },
              { label: 'Primary', value: 'primary' },
            ]}
            onChange={(surface) => onChange({ ...block, surface })}
          />
          {onEditNavigation && block.navigationDesignId ? (
            <button
              type="button"
              className="button"
              onClick={() => onEditNavigation(block.navigationDesignId!)}
            >
              Edit in Navigation Designer
            </button>
          ) : null}
        </div>
      );
  }
}
