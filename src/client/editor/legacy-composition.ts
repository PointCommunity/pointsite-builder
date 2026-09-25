import { independentResponsiveValue, type GridArea } from '../../site-kit/grid-layout';
import type { SiteDocument, SiteElement } from '../../site-kit/types';
import { isSafeMailtoUrl } from '../../site-kit/url-policy';

type Group = Extract<SiteElement, { type: 'composition' }>;
type Child = Group['items'][number];
const frameAspect = {
  natural: 'natural',
  portrait: '4:5',
  square: '1:1',
  landscape: '16:9',
} as const;

const area = (column: number, row: number, columnSpan: number, rowSpan: number): GridArea => ({
  column,
  row,
  columnSpan,
  rowSpan,
});

function text(
  value: string,
  semantic: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6',
  style: 'body' | 'lead' | 'eyebrow' | 'title' | 'display',
  align: 'left' | 'center' | 'right' = 'left',
): Child['element'] {
  return { id: crypto.randomUUID(), type: 'text', text: value, semantic, style, align };
}

function image(
  mediaId: string,
  alt: string,
  fit: 'cover' | 'contain' | 'stretch' = 'cover',
  focal?: { x: number; y: number },
  aspect: Extract<SiteElement, { type: 'image' }>['aspect'] = 'natural',
): Child['element'] {
  return {
    id: crypto.randomUUID(),
    type: 'image',
    mediaId,
    alt,
    aspect,
    fit,
    ...(focal ? { focal } : {}),
  };
}

function button(
  action: { label: string; href: string; style: 'primary' | 'secondary' | 'quiet' },
  align: 'left' | 'center' | 'right' = 'left',
): Child['element'] {
  return { id: crypto.randomUUID(), type: 'button', ...action, width: 'fit', align };
}

/** An opt-in content extraction. Existing documents and collection records are never rewritten. */
export function canConvertLegacy(block: SiteElement): boolean {
  return (
    ['hero', 'heading', 'form', 'cards', 'splitFeature'].includes(block.type) ||
    (block.type === 'people' && block.personIds.length <= 8)
  );
}

export function compositionFromLegacy(
  block: SiteElement,
  document: SiteDocument,
): Group | undefined {
  if (!canConvertLegacy(block)) return undefined;
  const items: Child[] = [];
  const add = (
    element: Child['element'],
    desktop: GridArea,
    mobile: GridArea = desktop,
    layer = 0,
  ) => {
    items.push({
      id: crypto.randomUUID(),
      span: desktop.columnSpan,
      align: independentResponsiveValue('stretch'),
      grid: { desktop, tablet: desktop, mobile },
      layer,
      element,
    });
  };
  const addText = (
    value: string | undefined,
    semantic: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6',
    style: 'body' | 'lead' | 'eyebrow' | 'title' | 'display',
    desktop: GridArea,
    mobile: GridArea = desktop,
    align: 'left' | 'center' | 'right' = 'left',
  ) => {
    if (value) add(text(value, semantic, style, align), desktop, mobile);
  };
  const addActions = (
    actions: Array<{ label: string; href: string; style: 'primary' | 'secondary' | 'quiet' }>,
    row: number,
    align: 'left' | 'center' = 'left',
    mobileRow = row,
  ) => {
    actions.forEach((action, index) =>
      add(
        button(action, align),
        area(1 + index * 4, row, 4, 2),
        area(1, mobileRow + index * 2, 12, 2),
      ),
    );
  };
  let surface: Group['surface'] = 'transparent';

  if (block.type === 'hero') {
    const align = block.align;
    surface = block.surface === 'image' ? 'primary' : block.surface;
    if (block.mediaId) {
      const alt = document.media.find((media) => media.id === block.mediaId)?.alt ?? '';
      add(
        {
          ...image(block.mediaId, alt, 'cover', block.mediaFocal),
          ...(block.surface === 'image' ? { overlay: 'dark' as const } : {}),
        },
        area(1, 1, 12, 12),
        area(1, 1, 12, 20),
        -1,
      );
    }
    addText(block.eyebrow, 'p', 'eyebrow', area(2, 2, 10, 1), area(1, 2, 12, 1), align);
    addText(block.heading, 'h1', 'display', area(2, 4, 10, 3), area(1, 4, 12, 6), align);
    addText(block.body, 'p', 'body', area(3, 8, 8, 2), area(1, 11, 12, 3), align);
    addActions(block.actions, 11, align, 16);
  } else if (block.type === 'heading') {
    addText(block.eyebrow, 'p', 'eyebrow', area(1, 1, 12, 1), undefined, block.align);
    addText(block.text, `h${block.level}`, 'title', area(1, 2, 12, 2), undefined, block.align);
    addText(block.supportingText, 'p', 'body', area(1, 5, 12, 2), undefined, block.align);
    addActions(block.actions ?? [], 8, block.align);
  } else if (block.type === 'splitFeature') {
    surface = block.surface;
    const banner = block.variant === 'photoBanner';
    const mediaColumn = banner || block.mediaSide === 'left' ? 1 : 7;
    const copyColumn = banner || block.mediaSide === 'right' ? 2 : 7;
    const copySpan = banner ? 10 : 6;
    const copyAlign = block.textAlign ?? 'left';
    const desktopBodyRows = Math.max(5, Math.ceil(block.body.length / 45));
    const mobileBodyRows = Math.max(8, Math.ceil(block.body.length / 20));
    const desktopBodyRow = block.eyebrow ? 7 : 5;
    const mobileBodyRow = block.eyebrow ? 18 : 16;
    const desktopNoteRow = desktopBodyRow + desktopBodyRows + 1;
    const mobileNoteRow = mobileBodyRow + mobileBodyRows + 1;
    const desktopCalloutRow = desktopNoteRow + (block.note ? 3 : 0);
    const mobileCalloutRow = mobileNoteRow + (block.note ? 3 : 0);
    const desktopValueRow = desktopCalloutRow + (block.calloutLabel ? 2 : 0);
    const mobileValueRow = mobileCalloutRow + (block.calloutLabel ? 2 : 0);
    const desktopActionRow = desktopValueRow + (block.calloutValue ? 2 : 0) + 1;
    const mobileActionRow = mobileValueRow + (block.calloutValue ? 2 : 0) + 1;
    const mediaAlt =
      block.mediaAlt ?? document.media.find((media) => media.id === block.mediaId)?.alt ?? '';
    add(
      {
        ...image(block.mediaId, mediaAlt, 'cover', block.mediaFocal),
        ...(banner ? { overlay: 'dark' as const } : {}),
      },
      area(mediaColumn, 1, banner ? 12 : 6, Math.max(14, desktopActionRow + 2)),
      area(1, 1, 12, 8),
      banner ? -1 : 0,
    );
    addText(
      block.eyebrow,
      'p',
      'eyebrow',
      area(copyColumn, banner ? 2 : 1, copySpan, 1),
      area(1, 10, 12, 1),
      copyAlign,
    );
    addText(
      block.heading,
      'h2',
      'title',
      area(copyColumn, block.eyebrow ? 3 : 1, copySpan, 3),
      area(1, block.eyebrow ? 12 : 10, 12, 5),
      copyAlign,
    );
    addText(
      block.body,
      'p',
      'body',
      area(copyColumn, desktopBodyRow, copySpan, desktopBodyRows),
      area(1, mobileBodyRow, 12, mobileBodyRows),
      copyAlign,
    );
    addText(
      block.note,
      'p',
      'body',
      area(copyColumn, desktopNoteRow, copySpan, 2),
      area(1, mobileNoteRow, 12, 2),
      copyAlign,
    );
    addText(
      block.calloutLabel,
      'p',
      'eyebrow',
      area(copyColumn, desktopCalloutRow, copySpan, 1),
      area(1, mobileCalloutRow, 12, 1),
      copyAlign,
    );
    addText(
      block.calloutValue,
      'p',
      'lead',
      area(copyColumn, desktopValueRow, copySpan, 1),
      area(1, mobileValueRow, 12, 1),
      copyAlign,
    );
    if (block.action)
      add(
        button(block.action, copyAlign),
        area(copyColumn, desktopActionRow, banner ? 4 : 6, 2),
        area(1, mobileActionRow, 12, 2),
      );
  } else if (block.type === 'form') {
    const [firstLine = '', ...otherLines] = (block.body ?? '').split('\n');
    const emailHref =
      block.variant === 'contact' && isSafeMailtoUrl(`mailto:${firstLine}`)
        ? `mailto:${firstLine}`
        : undefined;
    addText(block.eyebrow, 'p', 'eyebrow', area(1, 1, 5, 1), area(1, 1, 12, 1));
    addText(block.heading, 'h2', 'title', area(1, 2, 5, 2), area(1, 2, 12, 3));
    if (emailHref)
      add(
        button({ label: firstLine, href: emailHref, style: 'quiet' }),
        area(1, 5, 5, 2),
        area(1, 6, 12, 2),
      );
    addText(
      emailHref ? otherLines.join('\n') : block.body,
      'p',
      'body',
      area(1, emailHref ? 7 : 5, 5, 3),
      area(1, emailHref ? 8 : 6, 12, 3),
    );
    addText(block.supportingText, 'p', 'body', area(1, 11, 5, 2), area(1, 12, 12, 2));
    if (block.linkHref && block.linkLabel)
      add(
        button({ label: block.linkLabel, href: block.linkHref, style: 'quiet' }),
        area(1, 14, 5, 2),
        area(1, 15, 12, 2),
      );
    add(
      {
        id: crypto.randomUUID(),
        type: 'form',
        formId: block.formId,
        variant: 'standard',
        legacyChrome: block.legacyChrome,
      },
      area(7, 1, 6, 16),
      area(1, 18, 12, 14),
    );
  } else if (block.type === 'cards') {
    addText(block.eyebrow, 'p', 'eyebrow', area(1, 1, 12, 1));
    addText(block.heading, 'h2', 'lead', area(1, 2, 12, 2));
    const width = 12 / block.columns;
    block.items.forEach((card, index) => {
      const column = 1 + (index % block.columns) * width;
      const row = 5 + Math.floor(index / block.columns) * 10;
      const mobileRow = 4 + index * 8;
      if (card.mediaId)
        add(
          image(
            card.mediaId,
            card.mediaAlt ?? document.media.find((media) => media.id === card.mediaId)?.alt ?? '',
            card.mediaFit ?? 'cover',
            card.mediaFocal,
            frameAspect[card.mediaFrame ?? 'natural'],
          ),
          area(column, row, width, 4),
          area(1, mobileRow, 12, 3),
        );
      addText(
        card.eyebrow,
        'p',
        'eyebrow',
        area(column, row + 4, width, 1),
        area(1, mobileRow + 3, 12, 1),
      );
      addText(
        card.title,
        'h3',
        'lead',
        area(column, row + 5, width, 1),
        area(1, mobileRow + 4, 12, 1),
      );
      addText(
        card.body,
        'p',
        'body',
        area(column, row + 6, width, 2),
        area(1, mobileRow + 5, 12, 2),
      );
      addText(
        card.supportingText,
        'p',
        'body',
        area(column, row + 8, width, 1),
        area(1, mobileRow + 7, 12, 1),
      );
      if (card.href)
        add(
          button({ label: card.title || 'Learn more', href: card.href, style: 'quiet' }),
          area(column, row + 9, width, 1),
          area(1, mobileRow + 8, 12, 1),
        );
    });
  } else if (block.type === 'people') {
    // A larger collection needs multiple groups; leave it intact rather than clip mobile content.
    if (block.personIds.length > 8) return undefined;
    addText(block.heading, 'h2', 'lead', area(1, 1, 12, 2));
    block.personIds.forEach((id, index) => {
      const person = document.collections.people.find((candidate) => candidate.id === id);
      if (!person) return;
      const column = 1 + (index % 2) * 6;
      const row = 4 + Math.floor(index / 2) * 12;
      const mobileRow = 4 + index * 12;
      if (person.mediaId)
        add(
          image(
            person.mediaId,
            person.mediaAlt ?? person.name,
            person.mediaFit ?? 'contain',
            person.mediaFocal,
            frameAspect[person.mediaFrame ?? 'natural'],
          ),
          area(column, row, 6, 5),
          area(1, mobileRow, 12, 5),
        );
      addText(
        person.name,
        'h3',
        'lead',
        area(column, row + 5, 6, 2),
        area(1, mobileRow + 5, 12, 2),
      );
      addText(person.role, 'p', 'body', area(column, row + 7, 6, 2), area(1, mobileRow + 7, 12, 2));
      addText(person.bio, 'p', 'body', area(column, row + 9, 6, 3), area(1, mobileRow + 9, 12, 3));
    });
  } else {
    return undefined;
  }
  return {
    id: block.id,
    type: 'composition',
    name: `${block.type[0].toUpperCase()}${block.type.slice(1).replace(/([A-Z])/g, ' $1')} content`,
    surface,
    items,
  };
}
