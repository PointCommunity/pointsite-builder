import { z } from 'zod';
import {
  CanonicalRouteSchema,
  SafeHrefSchema,
  SafeHttpsUrlSchema,
  isSafeExternalHttpUrl,
  isSafeInternalPath,
} from './url-policy';
import { isDirectVideoUrl, youtubeVideoId } from './linked-media';
import { areasOverlap, GRID_BREAKPOINTS } from './grid-layout';

const uuid = z.uuid();
const shortText = z.string().trim().min(1).max(120);
const bodyText = z.string().trim().min(1).max(5_000);
const editableShortText = z.string().trim().max(120);
const editableBodyText = z.string().trim().max(5_000);
const imageFrame = z.enum(['natural', 'portrait', 'square', 'landscape']);
const focalPoint = z.strictObject({
  x: z.number().int().min(0).max(100),
  y: z.number().int().min(0).max(100),
});
const optionalBodyText = z.string().trim().max(5_000).optional();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hexadecimal color');
const responsiveHeroWidth = z.strictObject({
  desktop: z.number().int().min(30).max(100),
  tablet: z.number().int().min(30).max(100),
  mobile: z.number().int().min(30).max(100),
});

function relativeLuminance(hex: string): number {
  const values = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [red = 0, green = 0, blue = 0] = values.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

const ActionSchema = z.strictObject({
  label: z.string().trim().max(60),
  href: SafeHrefSchema,
  style: z.enum(['primary', 'secondary', 'quiet']),
});

const BlockBase = { id: uuid } as const;
const SocialLinkSchema = z.strictObject({
  platform: z.enum(['facebook', 'instagram', 'youtube', 'x', 'other']),
  label: editableShortText,
  url: SafeHttpsUrlSchema,
});

const HeroBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('hero'),
  eyebrow: z.string().trim().max(80).optional(),
  heading: z.string().trim().max(180),
  body: optionalBodyText,
  mediaId: uuid.optional(),
  mediaFocal: focalPoint.optional(),
  align: z.enum(['left', 'center']),
  surface: z.enum(['canvas', 'primary', 'image']),
  actions: z.array(ActionSchema).max(2).default([]),
  variant: z.enum(['standard', 'homeHero', 'pageHero']).optional(),
  headingWidth: responsiveHeroWidth.default({ desktop: 100, tablet: 100, mobile: 100 }),
  bodyWidth: responsiveHeroWidth.default({ desktop: 100, tablet: 100, mobile: 100 }),
});

const HeadingBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('heading'),
  text: z.string().trim().max(240),
  level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  align: z.enum(['left', 'center']),
  width: z.enum(['narrow', 'wide']),
  supportingText: optionalBodyText,
  eyebrow: z.string().trim().max(80).optional(),
  actions: z.array(ActionSchema).max(2).optional(),
  variant: z.enum(['standard', 'homeIntro']).optional(),
});

const InlineTextSchema = z.strictObject({
  text: z.string().max(2_000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});

const RichTextNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('paragraph'),
    children: z.array(InlineTextSchema).min(1).max(30),
  }),
  z.strictObject({
    type: z.literal('bulletedList'),
    items: z.array(editableShortText).min(1).max(30),
  }),
  z.strictObject({
    type: z.literal('numberedList'),
    items: z.array(editableShortText).min(1).max(30),
  }),
  z.strictObject({
    type: z.literal('quote'),
    text: editableBodyText,
    attribution: editableShortText.optional(),
  }),
  z.strictObject({ type: z.literal('address'), text: editableBodyText }),
  z.strictObject({ type: z.literal('link'), text: editableShortText, href: SafeHrefSchema }),
]);

const RichTextBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('richText'),
  content: z.array(RichTextNodeSchema).min(1).max(100),
  eyebrow: z.string().trim().max(80).optional(),
  heading: z.string().trim().max(180).optional(),
  variant: z.enum(['standard', 'prose', 'footer']).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});

const ImageBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('image'),
  mediaId: uuid,
  focal: focalPoint.optional(),
  alt: z.string().trim().max(300),
  aspect: z.enum(['natural', '1:1', '4:3', '4:5', '16:9']),
  fit: z.enum(['cover', 'contain', 'stretch']),
  wrap: z.boolean().optional(),
  overlay: z.enum(['none', 'light', 'dark']).optional(),
  caption: z.string().trim().max(500).optional(),
  variant: z.enum(['standard', 'wide']).optional(),
  href: z
    .string()
    .max(2048)
    .refine(
      (value) => isSafeInternalPath(value) || isSafeExternalHttpUrl(value),
      'Image link must be an internal page or HTTP/HTTPS URL',
    )
    .optional(),
});

const MediaEmbedBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('mediaEmbed'),
  linkedMediaId: uuid,
  aspect: z.enum(['natural', '1:1', '4:3', '16:9']),
  fit: z.enum(['cover', 'contain']),
  caption: z.string().trim().max(500).optional(),
});

const SplitFeatureBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('splitFeature'),
  eyebrow: z.string().trim().max(80).optional(),
  heading: z.string().trim().max(180),
  body: editableBodyText,
  mediaId: uuid,
  mediaFocal: focalPoint.optional(),
  mediaAlt: z.string().trim().max(300).optional(),
  mediaSide: z.enum(['left', 'right']),
  proportion: z.enum(['half', 'mediaWide', 'contentWide']),
  align: z.enum(['start', 'center', 'end']),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  surface: z.enum(['canvas', 'surface', 'primary']),
  action: ActionSchema.optional(),
  note: z.string().trim().max(500).optional(),
  calloutLabel: z.string().trim().max(120).optional(),
  calloutValue: z.string().trim().max(120).optional(),
  variant: z.enum(['standard', 'photoBanner', 'splitFeature', 'imageSplit']).optional(),
});

const CtaBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('cta'),
  heading: z.string().trim().max(180),
  body: optionalBodyText,
  action: ActionSchema,
  surface: z.enum(['canvas', 'surface', 'primary']),
  eyebrow: z.string().trim().max(80).optional(),
  variant: z.enum(['standard', 'rental']).optional(),
});

const CardsBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('cards'),
  eyebrow: z.string().trim().max(80).optional(),
  heading: z.string().trim().max(180).optional(),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  items: z
    .array(
      z.strictObject({
        eyebrow: z.string().trim().max(80).optional(),
        title: editableShortText,
        body: editableBodyText,
        supportingText: z.string().trim().max(500).optional(),
        mediaId: uuid.optional(),
        mediaAlt: z.string().trim().max(300).optional(),
        mediaFit: z.enum(['cover', 'contain', 'stretch']).optional(),
        mediaFrame: imageFrame.optional(),
        mediaFocal: focalPoint.optional(),
        href: SafeHrefSchema.optional(),
      }),
    )
    .min(1)
    .max(12),
  variant: z
    .enum([
      'standard',
      'splitEditorial',
      'splitEditorialTone',
      'identity',
      'beliefs',
      'groups',
      'giving',
    ])
    .optional(),
});

const PeopleBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('people'),
  heading: z.string().trim().max(180).optional(),
  personIds: z.array(uuid).min(1).max(24),
  layout: z.enum(['grid', 'featured']),
  variant: z.enum(['standard', 'leadership', 'horizontal']).optional(),
});

const FaqBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('faq'),
  heading: z.string().trim().max(180).optional(),
  items: z
    .array(
      z.strictObject({
        question: editableShortText,
        answer: editableBodyText,
        initiallyOpen: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(30),
  eyebrow: z.string().trim().max(80).optional(),
  variant: z.enum(['standard', 'groups']).optional(),
});

const FormBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('form'),
  formId: uuid,
  heading: z.string().trim().max(180).optional(),
  supportingText: optionalBodyText,
  eyebrow: z.string().trim().max(80).optional(),
  body: optionalBodyText,
  linkLabel: z.string().trim().max(80).optional(),
  linkHref: SafeHrefSchema.optional(),
  variant: z.enum(['standard', 'panel', 'standalone', 'contact']).optional(),
  legacyChrome: z.boolean().optional(),
});

const MapBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('map'),
  query: z.string().trim().max(300).refine(isSafePlainText, 'Map query contains unsafe content'),
  title: z.string().trim().max(180),
  eyebrow: z.string().trim().max(80).optional(),
  heading: z.string().trim().max(180).optional(),
  body: optionalBodyText,
  variant: z.enum(['standard', 'gathering']).optional(),
});

const DividerBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('divider'),
  style: z.enum(['line', 'space']),
  variant: z.enum(['standard']).optional(),
});

const SpacerBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('spacer'),
  size: z.enum(['small', 'medium', 'large']),
  variant: z.enum(['standard']).optional(),
});

const TextBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('text'),
  text: z.string().trim().max(5_000),
  style: z.enum(['body', 'lead', 'eyebrow', 'small', 'title', 'display']),
  align: z.enum(['left', 'center']),
  semantic: z.enum(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']).optional(),
});

const ButtonBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('button'),
  label: z.string().trim().max(60),
  href: SafeHrefSchema,
  style: z.enum(['primary', 'secondary', 'quiet']),
  width: z.enum(['fit', 'full']),
  align: z.enum(['left', 'center', 'right']),
});

const NavigationBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('navigation'),
  navigationDesignId: uuid.optional(),
  label: z.string().trim().max(80),
  orientation: z.enum(['responsive', 'horizontal', 'vertical']),
  align: z.enum(['left', 'center', 'right']),
  surface: z.enum(['transparent', 'canvas', 'primary']),
});

const SocialLinksBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('socialLinks'),
  heading: z.string().trim().max(180).optional(),
  links: z.array(SocialLinkSchema).max(12),
  align: z.enum(['left', 'center', 'right']),
  appearance: z.enum(['icons', 'labels']),
  variant: z.enum(['standard', 'footer']).optional(),
});

function isSafePlainText(value: string): boolean {
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === '<' || character === '>' || codePoint < 32 || codePoint === 127;
  });
}

export const PrimitiveSiteElementSchema = z.discriminatedUnion('type', [
  HeroBlockSchema,
  HeadingBlockSchema,
  RichTextBlockSchema,
  ImageBlockSchema,
  MediaEmbedBlockSchema,
  SplitFeatureBlockSchema,
  CtaBlockSchema,
  CardsBlockSchema,
  PeopleBlockSchema,
  FaqBlockSchema,
  FormBlockSchema,
  MapBlockSchema,
  DividerBlockSchema,
  SpacerBlockSchema,
  TextBlockSchema,
  ButtonBlockSchema,
  NavigationBlockSchema,
  SocialLinksBlockSchema,
]);

export const GridAreaSchema = z
  .strictObject({
    column: z.number().int().min(1).max(12),
    row: z.number().int().min(1).max(1_000),
    columnSpan: z.number().int().min(1).max(12),
    rowSpan: z.number().int().min(1).max(100),
  })
  .superRefine((area, context) => {
    if (area.column + area.columnSpan > 13) {
      context.addIssue({
        code: 'custom',
        path: ['columnSpan'],
        message: 'Grid area must end at or before column 12',
      });
    }
  });

const ResponsiveGridAreaSchema = z.strictObject({
  desktop: GridAreaSchema,
  tablet: GridAreaSchema,
  mobile: GridAreaSchema,
});

const ResponsivePlacementAlignmentSchema = z.strictObject({
  desktop: z.enum(['start', 'center', 'end', 'stretch']),
  tablet: z.enum(['start', 'center', 'end', 'stretch']),
  mobile: z.enum(['start', 'center', 'end', 'stretch']),
});

const PrimitiveElementPlacementSchema = z.strictObject({
  id: uuid,
  span: z.number().int().min(1).max(12),
  align: ResponsivePlacementAlignmentSchema,
  grid: ResponsiveGridAreaSchema,
  element: PrimitiveSiteElementSchema,
});

export const ComposedBlockSchema = z
  .strictObject({
    ...BlockBase,
    type: z.literal('composition'),
    name: z.string().trim().max(80),
    surface: z.enum(['transparent', 'canvas', 'surface', 'primary']).optional(),
    items: z
      .array(
        z.strictObject({
          ...PrimitiveElementPlacementSchema.shape,
          layer: z.number().int().min(-20).max(20),
        }),
      )
      .max(100),
  })
  .superRefine((group, context) => {
    const placementIds = new Set<string>();
    const elementIds = new Set<string>();
    group.items.forEach((item, index) => {
      if (
        GRID_BREAKPOINTS.some(
          (breakpoint) => item.grid[breakpoint].row + item.grid[breakpoint].rowSpan - 1 > 100,
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'grid'],
          message: 'Group content must fit within 100 grid rows',
        });
      if (placementIds.has(item.id))
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'id'],
          message: 'Duplicate placement ID',
        });
      if (elementIds.has(item.element.id))
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'element', 'id'],
          message: 'Duplicate element ID',
        });
      placementIds.add(item.id);
      elementIds.add(item.element.id);
    });
  });

export const SiteElementSchema = z.discriminatedUnion('type', [
  ...PrimitiveSiteElementSchema.options,
  ComposedBlockSchema,
]);

const ElementPlacementSchema = z.strictObject({
  ...PrimitiveElementPlacementSchema.shape,
  layer: z.number().int().min(-20).max(20).optional(),
  element: SiteElementSchema,
});

export const SectionBlockSchema = z
  .strictObject({
    ...BlockBase,
    type: z.literal('section'),
    name: z.string().trim().min(1).max(80),
    layout: z.enum(['compatibility', 'flow', 'grid']),
    position: z.enum(['flow', 'overlay']),
    columns: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(6),
      z.literal(12),
    ]),
    gap: z.enum(['none', 'small', 'medium', 'large']),
    width: z.enum(['full', 'shell', 'narrow', 'site']),
    surface: z.enum(['transparent', 'canvas', 'surface', 'primary']),
    padding: z.enum(['none', 'small', 'medium', 'large']),
    gapPixels: z.number().int().min(0).max(160).optional(),
    paddingPixels: z.number().int().min(0).max(240).optional(),
    border: z.enum(['none', 'top', 'bottom', 'all']).optional(),
    stackAt: z.enum(['phone', 'smallTablet', 'tablet']).optional(),
    minRows: z.number().int().min(1).max(100),
    backgroundMediaId: uuid.optional(),
    backgroundPosition: z.enum(['top', 'center', 'bottom']),
    overlay: z.enum(['none', 'light', 'dark']),
    items: z.array(ElementPlacementSchema).max(60),
  })
  .superRefine((section, context) => {
    if (section.layout === 'compatibility' && section.items.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'Compatibility sections contain exactly one element',
      });
    }
    if (section.layout === 'grid' && section.columns !== 12) {
      context.addIssue({
        code: 'custom',
        path: ['columns'],
        message: 'Grid sections use exactly 12 columns',
      });
    }
  });

export const SiteBlockSchema = SectionBlockSchema;

const ThemeSchema = z
  .strictObject({
    preset: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
    colors: z.strictObject({
      canvas: color,
      surface: color,
      text: color,
      mutedText: color,
      primary: color,
      onPrimary: color,
      border: color,
    }),
    headingFont: z.enum(['serif', 'sans', 'display']),
    bodyFont: z.enum(['sans', 'humanist']),
    spacingDensity: z.enum(['compact', 'comfortable', 'spacious']),
    radius: z.enum(['square', 'soft', 'rounded']),
    buttonStyle: z.enum(['solid', 'outline', 'pill']),
    surfaceStyle: z.enum(['warm', 'clean', 'bold']),
  })
  .superRefine(({ colors }, context) => {
    const checks = [
      ['text', colors.text, colors.canvas],
      ['mutedText', colors.mutedText, colors.canvas],
      ['surfaceText', colors.text, colors.surface],
      ['onPrimary', colors.onPrimary, colors.primary],
    ] as const;
    for (const [role, foreground, background] of checks) {
      if (contrastRatio(foreground, background) < 4.5) {
        context.addIssue({
          code: 'custom',
          path: ['colors', role === 'surfaceText' ? 'text' : role],
          message: `${role} must have at least 4.5:1 contrast`,
        });
      }
    }
  });

const NavigationEntrySchema = z.strictObject({
  id: uuid,
  label: z.string().trim().min(1).max(60),
  href: SafeHrefSchema,
  children: z
    .array(
      z.strictObject({
        id: uuid,
        label: z.string().trim().min(1).max(60),
        href: SafeHrefSchema,
      }),
    )
    .max(12),
});

const NavigationDesignSchema = z
  .strictObject({
    id: uuid,
    name: shortText,
    items: z.array(NavigationEntrySchema).max(20),
  })
  .superRefine((design, context) => {
    const identities = new Set<string>();
    design.items.forEach((item, index) => {
      for (const [entry, path] of [
        [item, ['items', index, 'id']],
        ...item.children.map(
          (child, childIndex) => [child, ['items', index, 'children', childIndex, 'id']] as const,
        ),
      ] as const) {
        if (identities.has(entry.id))
          context.addIssue({
            code: 'custom',
            path: [...path],
            message: 'Menu item IDs must be unique within a design',
          });
        identities.add(entry.id);
      }
    });
  });

const FormSchema = z
  .strictObject({
    id: uuid,
    name: editableShortText,
    recipientEmail: z.email(),
    subject: z.string().trim().max(180),
    submitLabel: z.string().trim().max(60),
    heading: z.string().trim().max(180).optional(),
    introduction: z.string().trim().max(1_000).optional(),
    privacyNote: z.string().trim().max(500).optional(),
    successMessage: z.string().trim().max(500).optional(),
    layout: z.enum(['single', 'two-column', 'grid']).default('two-column'),
    density: z.enum(['comfortable', 'compact']).default('comfortable'),
    fields: z
      .array(
        z
          .strictObject({
            id: uuid,
            name: z.string().regex(/^[a-z][A-Za-z0-9_]{0,49}$/),
            label: editableShortText,
            type: z.enum([
              'text',
              'email',
              'tel',
              'url',
              'number',
              'date',
              'time',
              'textarea',
              'select',
              'radio',
              'checkbox',
            ]),
            required: z.boolean(),
            options: z.array(editableShortText).min(1).max(30).optional(),
            placeholder: z.string().trim().max(180).optional(),
            helpText: z.string().trim().max(300).optional(),
            width: z.enum(['half', 'full']).default('half'),
            grid: ResponsiveGridAreaSchema.optional(),
          })
          .superRefine((field, context) => {
            const needsOptions = ['select', 'radio', 'checkbox'].includes(field.type);
            if (needsOptions && !field.options) {
              context.addIssue({
                code: 'custom',
                path: ['options'],
                message: `${field.type} requires options`,
              });
            }
            if (!needsOptions && field.options) {
              context.addIssue({
                code: 'custom',
                path: ['options'],
                message: `${field.type} cannot define options`,
              });
            }
          }),
      )
      .min(1)
      .max(30),
  })
  .superRefine((form, context) => {
    if (form.layout !== 'grid') {
      if (form.fields.some((field) => field.grid))
        context.addIssue({
          code: 'custom',
          path: ['fields'],
          message: 'Field placements require a grid form',
        });
      return;
    }
    for (const [index, field] of form.fields.entries()) {
      if (!field.grid) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'grid'],
          message: 'Grid forms require every field to be placed',
        });
        continue;
      }
      for (const breakpoint of GRID_BREAKPOINTS) {
        const current = field.grid[breakpoint];
        const previous = form.fields[index - 1]?.grid?.[breakpoint];
        if (
          previous &&
          (current.row < previous.row ||
            (current.row === previous.row && current.column < previous.column))
        )
          context.addIssue({
            code: 'custom',
            path: ['fields', index, 'grid', breakpoint],
            message: 'Visual field order must follow keyboard order',
          });
        if (
          form.fields
            .slice(0, index)
            .some((other) => other.grid && areasOverlap(current, other.grid[breakpoint]))
        )
          context.addIssue({
            code: 'custom',
            path: ['fields', index, 'grid', breakpoint],
            message: 'Form fields cannot overlap',
          });
      }
    }
  });

const CollectionsSchema = z.strictObject({
  people: z.array(
    z.strictObject({
      id: uuid,
      name: shortText,
      role: shortText,
      bio: bodyText,
      mediaId: uuid.optional(),
      mediaAlt: z.string().trim().min(1).max(300).optional(),
      mediaFit: z.enum(['cover', 'contain', 'stretch']).optional(),
      mediaFrame: imageFrame.optional(),
      mediaFocal: focalPoint.optional(),
    }),
  ),
  beliefs: z.array(
    z.strictObject({
      id: uuid,
      title: shortText,
      body: bodyText,
      references: shortText.optional(),
    }),
  ),
  groups: z.array(
    z.strictObject({
      id: uuid,
      name: shortText,
      description: bodyText,
      status: z.enum(['active', 'inactive']),
      schedule: shortText.optional(),
      location: shortText.optional(),
      leaders: shortText.optional(),
      contactEmail: z.email().optional(),
    }),
  ),
  events: z.array(
    z.strictObject({
      id: uuid,
      name: shortText,
      description: bodyText,
      schedule: shortText,
      location: shortText,
      status: z.enum(['active', 'inactive']),
      href: SafeHrefSchema.optional(),
    }),
  ),
});

const PageSchema = z.strictObject({
  id: uuid,
  title: z.string().trim().min(1).max(120),
  route: CanonicalRouteSchema,
  status: z.enum(['draft', 'published', 'hidden']),
  template: z.enum(['home', 'standard']).optional(),
  metadata: z.strictObject({
    title: z.string().trim().min(1).max(70),
    description: z.string().trim().min(1).max(180),
    ogImageMediaId: uuid.optional(),
  }),
  blocks: z.array(SectionBlockSchema).max(100),
});

export const SiteDocumentSchema = z
  .strictObject({
    schemaVersion: z.union([z.literal(9), z.literal(10), z.literal(11), z.literal(12)]),
    rendererVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    site: z.strictObject({
      name: shortText,
      shortName: z.string().trim().min(1).max(40),
      mission: z.string().trim().min(1).max(300),
      email: z.email(),
      phone: z.string().trim().min(7).max(40).optional(),
      address: z.strictObject({
        street: shortText,
        city: shortText,
        region: z.string().trim().min(2).max(80),
        postalCode: z.string().trim().min(3).max(20),
      }),
      service: z.strictObject({ label: shortText, schedule: shortText }),
      givingUrl: SafeHttpsUrlSchema,
      socialLinks: z.array(SocialLinkSchema).max(12),
    }),
    theme: ThemeSchema,
    navigation: z.array(NavigationEntrySchema).max(20),
    navigationDesigns: z.array(NavigationDesignSchema).min(1).max(30).optional(),
    pages: z.array(PageSchema).min(1).max(100),
    forms: z.array(FormSchema).max(30),
    media: z
      .array(
        z.strictObject({
          id: uuid,
          sourcePath: z.string().regex(/^\/assets\/[a-z0-9][a-z0-9/_-]*\.(?:avif|jpe?g|png|webp)$/),
          alt: z.string().trim().max(300),
          displayName: z.string().trim().min(1).max(120).optional(),
          tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
        }),
      )
      .max(500),
    linkedMedia: z
      .array(
        z
          .strictObject({
            id: uuid,
            type: z.enum(['image', 'video', 'youtube']),
            url: SafeHttpsUrlSchema,
            displayName: shortText,
            alternativeText: z.string().trim().max(300).optional(),
            caption: z.string().trim().max(500).optional(),
            tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
          })
          .superRefine((item, context) => {
            if (item.type === 'image' && !item.alternativeText) {
              context.addIssue({
                code: 'custom',
                path: ['alternativeText'],
                message: 'Linked images require alternative text',
              });
            }
            if (item.type === 'youtube' && !youtubeVideoId(item.url)) {
              context.addIssue({
                code: 'custom',
                path: ['url'],
                message: 'Use a supported YouTube video URL',
              });
            }
            if (item.type === 'video' && !isDirectVideoUrl(item.url)) {
              context.addIssue({
                code: 'custom',
                path: ['url'],
                message: 'Direct video URLs must end in .mp4, .webm, or .ogv',
              });
            }
          }),
      )
      .max(500),
    collections: CollectionsSchema,
    footer: z.array(SectionBlockSchema).max(20).optional(),
  })
  .superRefine((document, context) => {
    const designs = document.navigationDesigns;
    if (document.schemaVersion === 9 && designs !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['navigationDesigns'],
        message: 'Navigation designs require schema version 10',
      });
    }
    if (document.schemaVersion >= 10) {
      if (!designs)
        context.addIssue({
          code: 'custom',
          path: ['navigationDesigns'],
          message: 'Navigation designs are required',
        });
      if (document.navigation.length)
        context.addIssue({
          code: 'custom',
          path: ['navigation'],
          message: 'Version 10 stores menu items only in Navigation designs',
        });
      if (document.rendererVersion !== `${document.schemaVersion}.0.0`)
        context.addIssue({
          code: 'custom',
          path: ['rendererVersion'],
          message: `Schema ${document.schemaVersion} requires renderer ${document.schemaVersion}.0.0`,
        });
    }
    if (
      document.schemaVersion >= 11 ? document.footer === undefined : document.footer !== undefined
    )
      context.addIssue({
        code: 'custom',
        path: ['footer'],
        message: 'Editable footers require schema 11 and an explicit section list',
      });
    if (document.schemaVersion < 12 && document.site.socialLinks.some((link) => !link.label))
      context.addIssue({
        code: 'custom',
        path: ['site', 'socialLinks'],
        message: 'Empty social link labels require schema version 12',
      });
    if (
      document.schemaVersion < 12 &&
      document.collections.people.some(
        (person) => person.mediaFit || person.mediaFrame || person.mediaFocal,
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['collections', 'people'],
        message: 'Person media controls require schema version 12',
      });
    if (
      document.schemaVersion < 12 &&
      document.forms.some(
        (form) => form.layout === 'grid' || form.fields.some((field) => field.grid),
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['forms'],
        message: 'Form grids require schema version 12',
      });
    if (
      document.schemaVersion < 12 &&
      document.forms.some(
        (form) =>
          !form.name ||
          !form.subject ||
          !form.submitLabel ||
          form.fields.some((field) => !field.label || field.options?.some((option) => !option)),
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['forms'],
        message: 'Empty form text requires schema version 12',
      });
    const designIds = new Set<string>();
    designs?.forEach((design, index) => {
      if (designIds.has(design.id))
        context.addIssue({
          code: 'custom',
          path: ['navigationDesigns', index, 'id'],
          message: 'Navigation design IDs must be unique',
        });
      designIds.add(design.id);
    });
    const regions = document.pages.map((page, index) => ({
      blocks: page.blocks,
      path: ['pages', index, 'blocks'] as (string | number)[],
    }));
    if (document.footer) regions.push({ blocks: document.footer, path: ['footer'] });
    regions.forEach(({ blocks, path }) =>
      blocks.forEach((section, sectionIndex) => {
        const sectionPath = [...path, sectionIndex];
        if (
          document.schemaVersion < 11 &&
          (section.width === 'site' ||
            section.gapPixels !== undefined ||
            section.paddingPixels !== undefined ||
            section.border !== undefined ||
            section.stackAt !== undefined)
        )
          context.addIssue({
            code: 'custom',
            path: sectionPath,
            message: 'These section styles require schema 11',
          });
        section.items.forEach((item, itemIndex) => {
          const elementPath = [...sectionPath, 'items', itemIndex, 'element'];
          if (document.schemaVersion < 12 && item.layer !== undefined)
            context.addIssue({
              code: 'custom',
              path: [...sectionPath, 'items', itemIndex, 'layer'],
              message: 'Page-level layers require schema version 12',
            });
          if (document.schemaVersion < 12 && item.element.type === 'composition')
            context.addIssue({
              code: 'custom',
              path: elementPath,
              message: 'Composed content requires schema version 12',
            });
          if (
            document.schemaVersion < 12 &&
            item.element.type === 'form' &&
            item.element.legacyChrome !== undefined
          )
            context.addIssue({
              code: 'custom',
              path: elementPath,
              message: 'Legacy form marker requires schema version 12',
            });
          if (
            document.schemaVersion < 12 &&
            ((item.element.type === 'text' &&
              (item.element.semantic !== undefined || item.element.text.length === 0)) ||
              (item.element.type === 'image' &&
                (item.element.href !== undefined ||
                  item.element.overlay !== undefined ||
                  item.element.wrap !== undefined)))
          )
            context.addIssue({
              code: 'custom',
              path: elementPath,
              message: 'Independent text and image links require schema version 12',
            });
          if (
            document.schemaVersion < 12 &&
            ((item.element.type === 'image' && item.element.fit === 'stretch') ||
              (item.element.type === 'cards' &&
                item.element.items.some(
                  (card) =>
                    card.mediaFit !== undefined ||
                    card.mediaFrame !== undefined ||
                    card.mediaFocal !== undefined,
                )))
          )
            context.addIssue({
              code: 'custom',
              path: elementPath,
              message: 'Custom image fit requires schema version 12',
            });
          if (
            document.schemaVersion < 12 &&
            ((item.element.type === 'image' && item.element.focal) ||
              (item.element.type === 'hero' && item.element.mediaFocal) ||
              (item.element.type === 'splitFeature' && item.element.mediaFocal))
          )
            context.addIssue({
              code: 'custom',
              path: elementPath,
              message: 'Image focal points require schema version 12',
            });
          if (document.schemaVersion < 12) {
            const element = item.element;
            const required = (() => {
              switch (element.type) {
                case 'hero':
                  return [element.heading, ...element.actions.map((action) => action.label)];
                case 'heading':
                  return [element.text, ...(element.actions ?? []).map((action) => action.label)];
                case 'image':
                  return [element.alt];
                case 'splitFeature':
                  return [
                    element.heading,
                    element.body,
                    ...(element.mediaAlt === undefined ? [] : [element.mediaAlt]),
                    ...(element.action ? [element.action.label] : []),
                  ];
                case 'cta':
                  return [element.heading, element.action.label];
                case 'cards':
                  return element.items.flatMap((card) => [
                    card.title,
                    card.body,
                    ...(card.mediaAlt === undefined ? [] : [card.mediaAlt]),
                  ]);
                case 'faq':
                  return element.items.flatMap((faq) => [faq.question, faq.answer]);
                case 'map':
                  return [element.query.length >= 3 ? element.query : '', element.title];
                case 'button':
                case 'navigation':
                  return [element.label];
                case 'socialLinks':
                  return element.links.map((link) => link.label);
                case 'richText':
                  return element.content.flatMap((node) => {
                    if (node.type === 'paragraph') return [];
                    if (node.type === 'bulletedList' || node.type === 'numberedList')
                      return node.items;
                    if (node.type === 'quote')
                      return [
                        node.text,
                        ...(node.attribution === undefined ? [] : [node.attribution]),
                      ];
                    return [node.text];
                  });
                default:
                  return [];
              }
            })();
            if (required.some((value) => !value))
              context.addIssue({
                code: 'custom',
                path: elementPath,
                message: 'Empty required legacy text requires schema version 12',
              });
          }
          if (
            document.schemaVersion < 11 &&
            (item.element.type === 'socialLinks' ||
              (item.element.type === 'richText' &&
                (item.element.variant === 'footer' ||
                  item.element.align !== undefined ||
                  item.element.content.some((node) => node.type === 'address'))))
          )
            context.addIssue({
              code: 'custom',
              path: elementPath,
              message: 'These block styles require schema 11',
            });
          if (item.element.type !== 'navigation') return;
          const reference = item.element.navigationDesignId;
          if (
            document.schemaVersion === 9
              ? reference !== undefined
              : !reference || !designIds.has(reference)
          ) {
            context.addIssue({
              code: 'custom',
              path: [...elementPath, 'navigationDesignId'],
              message:
                document.schemaVersion === 9
                  ? 'Navigation design references require schema version 10'
                  : 'Select an existing Navigation design',
            });
          }
        });
      }),
    );
    const routeOwners = new Map<string, number>();
    document.pages.forEach((page, index) => {
      const owner = routeOwners.get(page.route);
      if (owner !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['pages', index, 'route'],
          message: `Route duplicates pages.${owner}.route`,
        });
      } else {
        routeOwners.set(page.route, index);
      }
    });
  });
