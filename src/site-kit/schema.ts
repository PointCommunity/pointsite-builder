import { z } from 'zod';
import { CanonicalRouteSchema, SafeHrefSchema, SafeHttpsUrlSchema } from './url-policy';

const uuid = z.uuid();
const shortText = z.string().trim().min(1).max(120);
const bodyText = z.string().trim().min(1).max(5_000);
const optionalBodyText = z.string().trim().max(5_000).optional();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hexadecimal color');

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
  label: z.string().trim().min(1).max(60),
  href: SafeHrefSchema,
  style: z.enum(['primary', 'secondary', 'quiet']),
});

const BlockBase = { id: uuid } as const;

const HeroBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('hero'),
  eyebrow: z.string().trim().max(80).optional(),
  heading: z.string().trim().min(1).max(180),
  body: optionalBodyText,
  mediaId: uuid.optional(),
  align: z.enum(['left', 'center']),
  surface: z.enum(['canvas', 'primary', 'image']),
  actions: z.array(ActionSchema).max(2).default([]),
});

const HeadingBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('heading'),
  text: z.string().trim().min(1).max(240),
  level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  align: z.enum(['left', 'center']),
  width: z.enum(['narrow', 'wide']),
  supportingText: optionalBodyText,
});

const InlineTextSchema = z.strictObject({
  text: z.string().min(1).max(2_000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});

const RichTextNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('paragraph'),
    children: z.array(InlineTextSchema).min(1).max(30),
  }),
  z.strictObject({ type: z.literal('bulletedList'), items: z.array(shortText).min(1).max(30) }),
  z.strictObject({ type: z.literal('numberedList'), items: z.array(shortText).min(1).max(30) }),
  z.strictObject({ type: z.literal('quote'), text: bodyText, attribution: shortText.optional() }),
  z.strictObject({ type: z.literal('link'), text: shortText, href: SafeHrefSchema }),
]);

const RichTextBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('richText'),
  content: z.array(RichTextNodeSchema).min(1).max(100),
});

const ImageBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('image'),
  mediaId: uuid,
  alt: z.string().trim().min(1).max(300),
  aspect: z.enum(['natural', '1:1', '4:3', '16:9']),
  fit: z.enum(['cover', 'contain']),
  caption: z.string().trim().max(500).optional(),
});

const SplitFeatureBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('splitFeature'),
  eyebrow: z.string().trim().max(80).optional(),
  heading: z.string().trim().min(1).max(180),
  body: bodyText,
  mediaId: uuid,
  mediaAlt: z.string().trim().min(1).max(300).optional(),
  mediaSide: z.enum(['left', 'right']),
  proportion: z.enum(['half', 'mediaWide', 'contentWide']),
  align: z.enum(['start', 'center']),
  surface: z.enum(['canvas', 'surface', 'primary']),
  action: ActionSchema.optional(),
});

const CtaBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('cta'),
  heading: z.string().trim().min(1).max(180),
  body: optionalBodyText,
  action: ActionSchema,
  surface: z.enum(['canvas', 'surface', 'primary']),
});

const CardsBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('cards'),
  heading: z.string().trim().max(180).optional(),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  items: z
    .array(
      z.strictObject({
        title: shortText,
        body: bodyText,
        mediaId: uuid.optional(),
        mediaAlt: z.string().trim().min(1).max(300).optional(),
        href: SafeHrefSchema.optional(),
      }),
    )
    .min(1)
    .max(12),
});

const PeopleBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('people'),
  heading: z.string().trim().max(180).optional(),
  personIds: z.array(uuid).min(1).max(24),
  layout: z.enum(['grid', 'featured']),
});

const FaqBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('faq'),
  heading: z.string().trim().max(180).optional(),
  items: z
    .array(
      z.strictObject({
        question: shortText,
        answer: bodyText,
        initiallyOpen: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(30),
});

const FormBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('form'),
  formId: uuid,
  heading: z.string().trim().max(180).optional(),
  supportingText: optionalBodyText,
});

const MapBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('map'),
  query: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .refine(isSafePlainText, 'Map query contains unsafe content'),
  title: z.string().trim().min(1).max(180),
});

const DividerBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('divider'),
  style: z.enum(['line', 'space']),
});

const SpacerBlockSchema = z.strictObject({
  ...BlockBase,
  type: z.literal('spacer'),
  size: z.enum(['small', 'medium', 'large']),
});

function isSafePlainText(value: string): boolean {
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === '<' || character === '>' || codePoint < 32 || codePoint === 127;
  });
}

export const SiteBlockSchema = z.discriminatedUnion('type', [
  HeroBlockSchema,
  HeadingBlockSchema,
  RichTextBlockSchema,
  ImageBlockSchema,
  SplitFeatureBlockSchema,
  CtaBlockSchema,
  CardsBlockSchema,
  PeopleBlockSchema,
  FaqBlockSchema,
  FormBlockSchema,
  MapBlockSchema,
  DividerBlockSchema,
  SpacerBlockSchema,
]);

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

const FormSchema = z.strictObject({
  id: uuid,
  name: shortText,
  recipientEmail: z.email(),
  subject: z.string().trim().min(1).max(180),
  submitLabel: z.string().trim().min(1).max(60),
  fields: z
    .array(
      z
        .strictObject({
          id: uuid,
          name: z.string().regex(/^[a-z][A-Za-z0-9_]{0,49}$/),
          label: shortText,
          type: z.enum(['text', 'email', 'tel', 'textarea', 'select', 'radio', 'checkbox']),
          required: z.boolean(),
          options: z.array(shortText).min(1).max(30).optional(),
          placeholder: z.string().trim().max(180).optional(),
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
  metadata: z.strictObject({
    title: z.string().trim().min(1).max(70),
    description: z.string().trim().min(1).max(180),
    ogImageMediaId: uuid.optional(),
  }),
  blocks: z.array(SiteBlockSchema).max(100),
});

export const SiteDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
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
      socialLinks: z
        .array(
          z.strictObject({
            platform: z.enum(['facebook', 'instagram', 'youtube', 'x', 'other']),
            label: shortText,
            url: SafeHttpsUrlSchema,
          }),
        )
        .max(12),
    }),
    theme: ThemeSchema,
    navigation: z.array(NavigationEntrySchema).max(20),
    pages: z.array(PageSchema).min(1).max(100),
    forms: z.array(FormSchema).max(30),
    media: z
      .array(
        z.strictObject({
          id: uuid,
          sourcePath: z.string().regex(/^\/assets\/[a-z0-9][a-z0-9/_-]*\.(?:avif|jpe?g|png|webp)$/),
          alt: z.string().trim().max(300),
        }),
      )
      .max(500),
    collections: CollectionsSchema,
  })
  .superRefine((document, context) => {
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
