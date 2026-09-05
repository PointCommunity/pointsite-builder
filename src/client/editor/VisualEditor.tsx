import { Puck, type Config, type Data } from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import { blockDefinitions, renderBlock } from '../../site-kit/registry';
import { SiteBlockSchema } from '../../site-kit/schema';
import type { SiteBlock } from '../../site-kit/types';
import { useEditor } from './EditorProvider';

type CanvasProps = { block: string };
type ComponentMap = Record<SiteBlock['type'], CanvasProps>;

function defaultBlock(
  type: SiteBlock['type'],
  document: ReturnType<typeof useEditor>['document'],
): SiteBlock {
  const id = crypto.randomUUID();
  const mediaId = document.media[0]?.id ?? crypto.randomUUID();
  const formId = document.forms[0]?.id ?? crypto.randomUUID();
  const personId = document.collections.people[0]?.id ?? crypto.randomUUID();
  const defaults: Record<SiteBlock['type'], SiteBlock> = {
    hero: {
      id,
      type: 'hero',
      heading: 'Welcome to Point',
      body: 'Add a short welcome.',
      align: 'left',
      surface: 'primary',
      actions: [],
    },
    heading: {
      id,
      type: 'heading',
      text: 'Section heading',
      level: 2,
      align: 'left',
      width: 'wide',
    },
    richText: {
      id,
      type: 'richText',
      content: [{ type: 'paragraph', children: [{ text: 'Add your text here.' }] }],
    },
    image: {
      id,
      type: 'image',
      mediaId,
      alt: 'Describe this image',
      aspect: 'natural',
      fit: 'cover',
    },
    splitFeature: {
      id,
      type: 'splitFeature',
      heading: 'Feature heading',
      body: 'Describe this feature.',
      mediaId,
      mediaAlt: 'Describe this image',
      mediaSide: 'left',
      proportion: 'half',
      align: 'center',
      surface: 'canvas',
    },
    cta: {
      id,
      type: 'cta',
      heading: 'Take the next step',
      action: { label: 'Learn more', href: '/', style: 'primary' },
      surface: 'surface',
    },
    cards: {
      id,
      type: 'cards',
      columns: 3,
      items: [{ title: 'Card title', body: 'Card description.' }],
    },
    people: { id, type: 'people', personIds: [personId], layout: 'grid' },
    faq: { id, type: 'faq', items: [{ question: 'Question', answer: 'Answer' }] },
    form: { id, type: 'form', formId },
    map: { id, type: 'map', query: 'Austin, Texas', title: 'Find us' },
    divider: { id, type: 'divider', style: 'line' },
    spacer: { id, type: 'spacer', size: 'medium' },
  };
  return defaults[type];
}

export function VisualEditor({ pageId }: { pageId: string }) {
  const { document, updateDocument } = useEditor();
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) return <p>Choose a page to edit.</p>;

  const components = Object.fromEntries(
    (Object.keys(blockDefinitions) as SiteBlock['type'][]).map((type) => [
      type,
      {
        label: type.replace(/([A-Z])/g, ' $1'),
        fields: {},
        defaultProps: { block: JSON.stringify(defaultBlock(type, document)) },
        render: ({ block }: CanvasProps) => {
          const parsed = SiteBlockSchema.safeParse(JSON.parse(block || '{}'));
          return parsed.success ? (
            renderBlock(parsed.data, document)
          ) : (
            <p>Configure this module.</p>
          );
        },
      },
    ]),
  ) as unknown as Config<ComponentMap>['components'];
  const config: Config<ComponentMap> = { components };
  const data: Data = {
    content: page.blocks.map((block) => ({
      type: block.type,
      props: { id: block.id, block: JSON.stringify(block) },
    })),
    root: { props: {} },
  };

  return (
    <div className="visual-editor" aria-label={`Visual canvas for ${page.title}`}>
      <Puck
        config={config}
        data={data}
        onChange={(next) => {
          const blocks = next.content.map((item) => {
            const source = typeof item.props.block === 'string' ? item.props.block : '{}';
            return SiteBlockSchema.parse(JSON.parse(source));
          });
          updateDocument((draft) => {
            const target = draft.pages.find((candidate) => candidate.id === pageId);
            if (target) target.blocks = blocks;
            return draft;
          });
        }}
        onPublish={() => undefined}
        headerTitle={page.title}
      />
    </div>
  );
}
