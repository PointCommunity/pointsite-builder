import { independentResponsiveValue, type GridArea } from '../../site-kit/grid-layout';
import type { SiteDocument, SiteElement } from '../../site-kit/types';

type Group = Extract<SiteElement, { type: 'composition' }>;
type Child = Group['items'][number];

export const compositionPresetNames = [
  'Standard Hero',
  'Split Hero',
  'Editorial Hero',
  'Image Card',
  'Person Card',
  'FAQ Item',
  'Contact Area',
] as const;
export type CompositionPresetName = (typeof compositionPresetNames)[number];

function place(
  element: Child['element'],
  desktop: GridArea,
  tablet: GridArea,
  mobile: GridArea,
): Child {
  return {
    id: crypto.randomUUID(),
    span: desktop.columnSpan,
    align: independentResponsiveValue('stretch'),
    grid: { desktop, tablet, mobile },
    layer: 0,
    element,
  };
}

function text(
  value: string,
  semantic: 'h1' | 'h2' | 'h3' | 'p',
  style: 'lead' | 'body' | 'eyebrow',
  align: 'left' | 'center',
): Child['element'] {
  return { id: crypto.randomUUID(), type: 'text', text: value, semantic, style, align };
}

function button(): Child['element'] {
  return {
    id: crypto.randomUUID(),
    type: 'button',
    label: 'Learn more',
    href: '/',
    style: 'primary',
    width: 'fit',
    align: 'left',
  };
}

function media(document: SiteDocument, preferredId?: string): Child['element'] | null {
  const image =
    preferredId === undefined
      ? document.media.find((candidate) => candidate.alt)
      : document.media.find((candidate) => candidate.id === preferredId && candidate.alt);
  return image
    ? {
        id: crypto.randomUUID(),
        type: 'image',
        mediaId: image.id,
        alt: image.alt,
        aspect: 'natural',
        fit: 'cover',
      }
    : null;
}

const grid = (column: number, row: number, columnSpan: number, rowSpan: number): GridArea => ({
  column,
  row,
  columnSpan,
  rowSpan,
});

export function compositionPreset(name: CompositionPresetName, document: SiteDocument): Group {
  const items: Child[] = [];
  if (name === 'Standard Hero') {
    items.push(
      place(
        text('Your headline', 'h1', 'lead', 'center'),
        grid(1, 1, 12, 3),
        grid(1, 1, 12, 3),
        grid(1, 1, 12, 3),
      ),
      place(
        text('Add a short introduction.', 'p', 'body', 'center'),
        grid(2, 4, 10, 2),
        grid(2, 4, 10, 2),
        grid(1, 4, 12, 3),
      ),
      place(button(), grid(5, 7, 4, 2), grid(5, 7, 4, 2), grid(3, 8, 8, 2)),
    );
  } else if (name === 'Split Hero' || name === 'Editorial Hero') {
    const editorial = name === 'Editorial Hero';
    const textColumn = editorial ? 7 : 1;
    const imageColumn = editorial ? 1 : 8;
    const heading = editorial ? 'Tell your story' : 'A place to begin';
    items.push(
      place(
        text(heading, 'h1', 'lead', 'left'),
        grid(textColumn, 1, 6, 3),
        grid(textColumn, 1, 6, 3),
        grid(1, 1, 12, 3),
      ),
      place(
        text('Add a short introduction.', 'p', 'body', 'left'),
        grid(textColumn, 4, 6, 2),
        grid(textColumn, 4, 6, 2),
        grid(1, 4, 12, 3),
      ),
      place(button(), grid(textColumn, 7, 4, 2), grid(textColumn, 7, 4, 2), grid(1, 8, 8, 2)),
    );
    const image = media(document);
    if (image)
      items.push(
        place(image, grid(imageColumn, 1, 5, 8), grid(imageColumn, 1, 5, 8), grid(1, 11, 12, 8)),
      );
  } else if (name === 'Image Card' || name === 'Person Card') {
    const person = name === 'Person Card' ? document.collections.people[0] : undefined;
    const image = person
      ? person.mediaId
        ? media(document, person.mediaId)
        : null
      : media(document);
    if (image) {
      if (image.type === 'image') image.aspect = '4:3';
      items.push(place(image, grid(1, 1, 12, 5), grid(1, 1, 12, 5), grid(1, 1, 12, 5)));
    }
    items.push(
      place(
        text(person?.name ?? 'Card title', 'h3', 'lead', 'left'),
        grid(1, 6, 12, 2),
        grid(1, 6, 12, 2),
        grid(1, 6, 12, 2),
      ),
      place(
        text(person?.role ?? 'Add a short description.', 'p', 'body', 'left'),
        grid(1, 8, 12, 2),
        grid(1, 8, 12, 2),
        grid(1, 8, 12, 2),
      ),
    );
    if (person)
      items.push(
        place(
          text(person.bio, 'p', 'body', 'left'),
          grid(1, 10, 12, 3),
          grid(1, 10, 12, 3),
          grid(1, 10, 12, 3),
        ),
      );
  } else if (name === 'FAQ Item') {
    items.push(
      place(
        text('Common questions', 'h2', 'lead', 'left'),
        grid(1, 1, 12, 2),
        grid(1, 1, 12, 2),
        grid(1, 1, 12, 2),
      ),
      place(
        text('Add context for this question.', 'p', 'body', 'left'),
        grid(1, 3, 12, 2),
        grid(1, 3, 12, 2),
        grid(1, 3, 12, 2),
      ),
      place(
        {
          id: crypto.randomUUID(),
          type: 'faq',
          items: [{ question: 'Add a question', answer: 'Add an answer.' }],
        },
        grid(1, 5, 12, 4),
        grid(1, 5, 12, 4),
        grid(1, 5, 12, 4),
      ),
    );
  } else {
    items.push(
      place(
        text('Contact us', 'h2', 'lead', 'left'),
        grid(1, 1, 5, 2),
        grid(1, 1, 5, 2),
        grid(1, 1, 12, 2),
      ),
      place(
        text('We would love to hear from you.', 'p', 'body', 'left'),
        grid(1, 3, 5, 2),
        grid(1, 3, 5, 2),
        grid(1, 3, 12, 2),
      ),
      place(
        text(document.site.email, 'p', 'body', 'left'),
        grid(1, 6, 5, 2),
        grid(1, 6, 5, 2),
        grid(1, 6, 12, 2),
      ),
    );
    const form = document.forms[0];
    if (form)
      items.push(
        place(
          { id: crypto.randomUUID(), type: 'form', formId: form.id },
          grid(7, 1, 6, 12),
          grid(7, 1, 6, 12),
          grid(1, 9, 12, 12),
        ),
      );
  }
  return { id: crypto.randomUUID(), type: 'composition', name, items };
}
