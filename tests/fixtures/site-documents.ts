export const IDS = {
  page: '11111111-1111-4111-8111-111111111111',
  block: '22222222-2222-4222-8222-222222222222',
  nav: '33333333-3333-4333-8333-333333333333',
  form: '44444444-4444-4444-8444-444444444444',
  field: '55555555-5555-4555-8555-555555555555',
  person: '66666666-6666-4666-8666-666666666666',
  belief: '77777777-7777-4777-8777-777777777777',
  group: '88888888-8888-4888-8888-888888888888',
  event: '99999999-9999-4999-8999-999999999999',
} as const;

export const validSiteDocument = {
  schemaVersion: 1,
  rendererVersion: '1.0.0',
  site: {
    name: 'Point Community Church',
    shortName: 'Point',
    mission: 'Know God. Find family. Make a difference.',
    email: 'hello@pointatx.org',
    phone: '+1 512 555 0100',
    address: {
      street: '11300 Old San Antonio Road',
      city: 'Manchaca',
      region: 'TX',
      postalCode: '78652',
    },
    service: { label: 'Sunday gathering', schedule: 'Sundays at 10:30 AM' },
    givingUrl: 'https://pointatx.org/give',
    socialLinks: [
      { platform: 'instagram', label: 'Point on Instagram', url: 'https://instagram.com/pointatx' },
    ],
  },
  theme: {
    preset: 'point-classic',
    colors: {
      canvas: '#f5f3ed',
      surface: '#ffffff',
      text: '#1f241e',
      mutedText: '#4f5a50',
      primary: '#3e522c',
      onPrimary: '#ffffff',
      border: '#c9d0c7',
    },
    headingFont: 'serif',
    bodyFont: 'sans',
    spacingDensity: 'comfortable',
    radius: 'soft',
    buttonStyle: 'solid',
    surfaceStyle: 'warm',
  },
  navigation: [{ id: IDS.nav, label: 'Home', href: '/', children: [] }],
  pages: [
    {
      id: IDS.page,
      title: 'Home',
      route: '/',
      status: 'published',
      metadata: {
        title: 'Point Community Church',
        description: 'A church community in South Austin.',
      },
      blocks: [
        {
          id: IDS.block,
          type: 'hero',
          eyebrow: 'Welcome home',
          heading: 'Find your people. Follow Jesus.',
          body: 'Join us this Sunday in South Austin.',
          align: 'left',
          surface: 'image',
          actions: [{ label: 'Plan a visit', href: '/visit', style: 'primary' }],
        },
      ],
    },
  ],
  forms: [
    {
      id: IDS.form,
      name: 'Contact',
      recipientEmail: 'hello@pointatx.org',
      subject: 'Website contact',
      submitLabel: 'Send message',
      fields: [
        {
          id: IDS.field,
          name: 'message',
          label: 'Message',
          type: 'textarea',
          required: true,
        },
      ],
    },
  ],
  media: [],
  collections: {
    people: [{ id: IDS.person, name: 'Point Team', role: 'Leadership', bio: 'Serving Point.' }],
    beliefs: [{ id: IDS.belief, title: 'Jesus', body: 'We center our life on Jesus.' }],
    groups: [
      { id: IDS.group, name: 'Community Group', description: 'Life together.', status: 'active' },
    ],
    events: [
      {
        id: IDS.event,
        name: 'Sunday Gathering',
        description: 'Weekly worship gathering.',
        schedule: 'Sundays at 10:30 AM',
        location: 'Point Community Church',
        status: 'active',
      },
    ],
  },
} as const;
