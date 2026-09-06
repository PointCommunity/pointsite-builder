import { IDS, validSiteDocument } from './site-documents';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { createCompatibilitySection } from '../../src/site-kit/migrations';
import type { SiteDocument, SiteElement } from '../../src/site-kit/types';

export const allBlocks: SiteElement[] = [
  {
    id: '22222222-2222-4222-8222-222222222201',
    type: 'hero',
    eyebrow: 'Welcome',
    heading: 'Point ATX',
    body: 'A family in South Austin.',
    align: 'left',
    surface: 'primary',
    actions: [{ label: 'Visit', href: '/visit', style: 'primary' }],
  },
  {
    id: '22222222-2222-4222-8222-222222222202',
    type: 'heading',
    text: 'A meaningful heading',
    level: 2,
    align: 'left',
    width: 'wide',
    supportingText: 'Supporting copy.',
  },
  {
    id: '22222222-2222-4222-8222-222222222203',
    type: 'richText',
    content: [
      { type: 'paragraph', children: [{ text: '<img src=x onerror=alert(1)>' }] },
      { type: 'link', text: 'External resource', href: 'https://example.com/resource' },
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222204',
    type: 'image',
    mediaId: IDS.person,
    alt: 'People sharing a meal',
    aspect: '16:9',
    fit: 'cover',
    caption: 'Life together',
  },
  {
    id: '22222222-2222-4222-8222-222222222205',
    type: 'splitFeature',
    heading: 'Together',
    body: 'Community.',
    mediaId: IDS.person,
    mediaAlt: 'Point gathering',
    mediaSide: 'left',
    proportion: 'half',
    align: 'center',
    surface: 'canvas',
  },
  {
    id: '22222222-2222-4222-8222-222222222206',
    type: 'cta',
    heading: 'Come visit',
    body: 'Sunday at 10:30.',
    action: {
      label: 'Directions',
      href: 'https://maps.google.com/?q=Point+ATX',
      style: 'secondary',
    },
    surface: 'primary',
  },
  {
    id: '22222222-2222-4222-8222-222222222207',
    type: 'cards',
    columns: 2,
    items: [
      { title: 'Family', body: 'Life together.' },
      { title: 'Mission', body: 'For our city.', href: '/mission' },
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222208',
    type: 'people',
    heading: 'Our team',
    personIds: [IDS.person],
    layout: 'grid',
  },
  {
    id: '22222222-2222-4222-8222-222222222209',
    type: 'faq',
    heading: 'Questions',
    items: [{ question: 'When do you meet?', answer: 'Sunday at 10:30.' }],
  },
  {
    id: '22222222-2222-4222-8222-222222222210',
    type: 'form',
    formId: IDS.form,
    heading: 'Contact us',
    supportingText: 'We would love to hear from you.',
  },
  {
    id: '22222222-2222-4222-8222-222222222211',
    type: 'map',
    query: '11300 Old San Antonio Road, Manchaca, TX',
    title: 'Point Community Church location',
  },
  { id: '22222222-2222-4222-8222-222222222212', type: 'divider', style: 'line' },
  { id: '22222222-2222-4222-8222-222222222213', type: 'spacer', size: 'medium' },
  {
    id: '22222222-2222-4222-8222-222222222214',
    type: 'text',
    text: 'Independent text box',
    style: 'body',
    align: 'left',
  },
  {
    id: '22222222-2222-4222-8222-222222222215',
    type: 'button',
    label: 'Get connected',
    href: '/contact',
    style: 'primary',
    width: 'fit',
    align: 'left',
  },
];

export const allBlocksDocument: SiteDocument = {
  ...SiteDocumentSchema.parse(validSiteDocument),
  media: [
    {
      id: IDS.person,
      sourcePath: '/assets/neighborhood-table.jpeg',
      alt: 'Friends and families sharing a meal',
    },
  ],
  pages: [
    {
      ...SiteDocumentSchema.parse(validSiteDocument).pages[0],
      blocks: allBlocks.map(createCompatibilitySection),
    },
  ],
};
