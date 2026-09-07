import { SiteDocumentSchema } from './schema';
import { createCompatibilitySection } from './migrations';
import { createEditableHeaderSection } from './editable-header';
import { createEditablePageHeroSection } from './editable-page-hero';
import type { SiteDocument, SiteElement } from './types';
import { RENDERER_VERSION, SCHEMA_VERSION } from './version';

function uid(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

let blockSequence = 1_000;
function block<T extends Omit<SiteElement, 'id'>>(value: T): T & { id: string } {
  blockSequence += 1;
  return { id: uid(blockSequence), ...value };
}

const media = [
  ['/assets/austin-skyline.jpeg', 'Austin skyline over the Colorado River'],
  ['/assets/neighborhood-table.jpeg', 'Friends and families sharing a meal'],
  ['/assets/next-generation.jpeg', 'Families worshiping together at Point ATX'],
  ['/assets/next-generation-secondary.jpeg', 'Point families gathering together'],
  ['/assets/pages/giving.png', 'Point Community Church giving'],
  ['/assets/pages/kids-ministry-1.jpeg', 'Children participating in Point kids ministry'],
  ['/assets/pages/kids-ministry-2.jpeg', 'Point ATX kids ministry'],
  ['/assets/pages/kids-ministry-3.jpeg', 'Children and families at Point ATX'],
  ['/assets/pages/neighborhood-map.png', 'Map of Point neighborhood groups'],
  ['/assets/pages/who-we-are.jpeg', 'Point Community Church gathered together'],
  ['/assets/people/gonzo-gonzales.jpeg', 'Gonzo Gonzales'],
  ['/assets/people/josh-currer.jpeg', 'Josh Currer'],
  ['/assets/people/landon-berryhill.jpeg', 'Landon Berryhill'],
  ['/assets/people/laura-munoz.jpeg', 'Laura Munoz'],
  ['/assets/people/nick-shock.jpeg', 'Nick Shock'],
  ['/assets/people/sandra-louviere.jpeg', 'Sandra Louviere'],
  ['/assets/people/tim-gillen.jpeg', 'Tim Gillen'],
  ['/assets/point-logo.png', 'Point Community Church'],
  ['/assets/point-wordmark.jpeg', 'Point Community Church'],
] as const;

const mediaRecords = media.map(([sourcePath, alt], index) => ({
  id: uid(2_000 + index),
  sourcePath,
  alt,
}));
const mediaId = (sourcePath: (typeof media)[number][0]): string => {
  const record = mediaRecords.find((candidate) => candidate.sourcePath === sourcePath);
  if (!record) throw new Error(`Missing media record for ${sourcePath}`);
  return record.id;
};

const people = [
  ['Nick Shock', 'Leadership & Teaching Elder', '/assets/people/nick-shock.jpeg'],
  ['Josh Currer', 'Teaching Elder', '/assets/people/josh-currer.jpeg'],
  ['Gonzo Gonzales', 'Elder', '/assets/people/gonzo-gonzales.jpeg'],
  ['Laura Munoz', 'Head of Kids Ministry', '/assets/people/laura-munoz.jpeg'],
  ['Sandra Louviere', 'Administrator', '/assets/people/sandra-louviere.jpeg'],
] as const;

const beliefs = [
  [
    'Bible',
    'We believe the Bible, as revealed to us in the Old and New Testaments, is our final authority and without error in its original manuscripts.',
    'Isaiah 40:8; Psalm 19:7; 2 Timothy 3:16; 2 Peter 1:20–21',
  ],
  [
    'God',
    'We believe in one God who exists eternally as three co-equal, fully divine persons: the Father, Son, and Holy Spirit.',
    'Deuteronomy 6:4; Matthew 28:19; John 10:30; 2 Corinthians 13:14',
  ],
  [
    'Jesus',
    'We believe that God incarnate, Jesus Christ, is both fully God and fully human at the same time.',
    'Isaiah 9:6; Matthew 1:18–25; John 1:1–14; Colossians 2:9',
  ],
  [
    'Humanity',
    'We believe every person has inherent worth and value because they are created in the image of God, and yet every person is a sinner by nature and choice and unable to justify themselves before God by their own deeds.',
    'Genesis 1:26–27; Psalm 139:14; Romans 7:18; Ephesians 2:1–3',
  ],
  [
    'Jesus’ death & resurrection',
    'We believe Jesus died in our place for our sins, was buried, and then was physically resurrected to new life.',
    'Isaiah 52:13–53:12; John 11:25; Romans 8:11; 1 Peter 2:24',
  ],
  [
    'Salvation',
    'We believe people are reconciled to God and receive the gift of eternal life by the grace of God through faith in Jesus Christ, not as the result of human effort.',
    'John 3:16–18; Romans 3:24; Ephesians 2:8–9; Titus 3:5',
  ],
  [
    'The return of Christ',
    'We believe Jesus Christ will return to the earth in the future to finalize his work of redemption and restoration.',
    'Daniel 7:13–14; Acts 1:11; 1 Thessalonians 4:15; Revelation 19:11–16',
  ],
] as const;

const groups = [
  [
    'Elm Grove NG',
    'Mondays at 5:30pm',
    '673 Oyster Creek, Buda, TX 78610',
    'Richard and Rose Paez',
  ],
  [
    'Coves of Cimarron NG',
    'Tuesdays at 6:00pm',
    'Lantana Trail, Buda, TX 78610',
    'Nick and Jada Shock',
  ],
  [
    'Oak Parke NG',
    'Thursdays at 6:00pm',
    'Leadville Drive, Austin, TX 78749',
    'Jase and Claire Michener',
  ],
  ['Hillcrest NG', 'Sundays at 6:00pm', 'Coats Cove, Austin, TX 78748', 'Aaron and Haley Negron'],
  [
    'Shadow Creek NG',
    'Wednesdays at 6:00pm',
    'South First, Austin, TX 78748',
    'Russel and Kristen Hutzler',
  ],
  [
    'The Bend at Nuckol’s Crossing NG',
    'Wednesdays at 6:00pm',
    'Marble Creek Loop, Austin, TX 78747',
    'Caleb Bryant',
  ],
] as const;

const groupFaqs = [
  [
    'What is a Neighborhood Group?',
    'A Neighborhood Group is a spiritual family living out Jesus’ mission to make disciples by helping one another grow in love for God and people. It is a family of Jesus followers on God’s mission.',
  ],
  [
    'Who is a Neighborhood Group for?',
    'Neighborhood Groups are for everyone because everyone needs authentic friendships built on grace and truth. They are a safe place to ask hard questions, wrestle with doubts, and mobilize with others to love and serve our city.',
  ],
  [
    'How should I decide which group to attend?',
    'We recommend beginning with the group geographically closest to you, making it easier to share everyday life. If that group does not work for you, another group will gladly welcome you.',
  ],
  [
    'What should I expect?',
    'Groups are friendly, honest, mixed-demographic communities that typically meet in a home. They often share meals, discuss God’s word, and pray with and for each other. Groups are much more than a weekly meeting.',
  ],
  [
    'What if I have kids?',
    'Every Neighborhood Group has childcare, though each group manages it differently. Check with the leader before attending for the details.',
  ],
  [
    'How can I get connected?',
    'We have groups from South Austin to Kyle. Fill out the connection form and someone will contact you, or ask our host team or pastoral staff to introduce you to a group leader on Sunday morning.',
  ],
] as const;

type FieldInput = {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'radio' | 'checkbox';
  required?: boolean;
  options?: string[];
};

let fieldSequence = 3_000;
const makeFields = (fields: FieldInput[]) =>
  fields.map((field) => {
    fieldSequence += 1;
    return { id: uid(fieldSequence), type: 'text' as const, required: false, ...field };
  });

const basicContactFields: FieldInput[] = [
  { name: 'firstName', label: 'First Name', required: true },
  { name: 'lastName', label: 'Last Name', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'message', label: 'Message', type: 'textarea', required: true },
];

const formDefinitions = [
  ['contact', 'Get In Touch', 'Contact Us', basicContactFields],
  ['beliefs', 'Want to learn more?', 'Contact Us', basicContactFields],
  ['kids', 'Contact Us', 'Contact Us', basicContactFields],
  ['giving', 'Have questions or need help?', 'Send', basicContactFields],
  [
    'connect-card',
    'Connect Card',
    'Send',
    [
      { name: 'firstName', label: 'First Name', required: true },
      { name: 'lastName', label: 'Last Name', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'address1', label: 'Address 1' },
      { name: 'address2', label: 'Address 2' },
      { name: 'city', label: 'City' },
      { name: 'state', label: 'State' },
      { name: 'postalCode', label: 'Zip / Postal Code' },
      {
        name: 'visits',
        label: 'How many times have you visited?',
        type: 'radio',
        options: ['This is my first time', 'A few times', 'Regular attender'],
      },
      {
        name: 'interests',
        label: 'I would like to learn more about',
        type: 'checkbox',
        options: ['Baptism', 'Volunteering', 'Membership', 'Neighborhood Groups', 'Jesus'],
      },
      { name: 'heardAbout', label: 'How did you hear about us?' },
      { name: 'message', label: "Anything else you'd like to share?", type: 'textarea' },
    ],
  ],
  [
    'prayer-request',
    'Prayer Request Form',
    'Send',
    [
      { name: 'request', label: 'How can we pray for you?', type: 'textarea', required: true },
      {
        name: 'followUp',
        label: 'Would you like someone to follow up?',
        type: 'radio',
        options: ['Yes', 'No'],
        required: true,
      },
      { name: 'firstName', label: 'First Name (optional)' },
      { name: 'lastName', label: 'Last Name (optional)' },
      { name: 'email', label: 'Email Address (optional)', type: 'email' },
      { name: 'phone', label: 'Phone Number (optional)', type: 'tel' },
    ],
  ],
  [
    'groups',
    'Live in community with a mission',
    'Send',
    [
      { name: 'firstName', label: 'First Name', required: true },
      { name: 'lastName', label: 'Last Name', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'phone', label: 'Phone Number', type: 'tel' },
      {
        name: 'location',
        label: 'Location',
        type: 'select',
        options: [
          'Southeast Austin',
          'Southwest Austin',
          'South Austin',
          'West Buda',
          'East Buda',
          'Kyle',
        ],
        required: true,
      },
    ],
  ],
  [
    'calendar',
    'Get text & updates on upcoming events',
    'Send',
    [
      { name: 'firstName', label: 'First Name', required: true },
      { name: 'phone', label: 'Mobile Phone', type: 'tel', required: true },
    ],
  ],
  [
    'building-rental',
    'Building Rental Request',
    'Submit',
    [
      { name: 'firstName', label: 'First Name', required: true },
      { name: 'lastName', label: 'Last Name', required: true },
      { name: 'phone', label: 'Phone Number', type: 'tel', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'organization', label: 'Organization', required: true },
      { name: 'schedule', label: 'Day, Time & Length of Rental', type: 'textarea', required: true },
    ],
  ],
] satisfies Array<[string, string, string, FieldInput[]]>;

const forms = formDefinitions.map(([name, title, submitLabel, fields], index) => ({
  id: uid(4_000 + index),
  name: title,
  recipientEmail: 'connect@pointaustin.org',
  subject: `${title} from PointATX.org`,
  submitLabel,
  fields: makeFields(fields),
  key: name,
}));
const formId = (key: string): string => {
  const form = forms.find((candidate) => candidate.key === key);
  if (!form) throw new Error(`Missing form ${key}`);
  return form.id;
};

const page = (
  sequence: number,
  title: string,
  route: string,
  description: string,
  elements: SiteElement[],
  chrome: {
    eyebrow?: string;
    intro?: string;
    heroMediaId?: string;
    template?: 'home' | 'standard';
  } = {},
): SiteDocument['pages'][number] => {
  const id = uid(5_000 + sequence);
  const template = chrome.template ?? (route === '/' ? 'home' : 'standard');
  return {
    id,
    title,
    route,
    status: 'published',
    template,
    metadata: { title: `${title} | Point Community Church`, description },
    blocks: [
      ...(template === 'standard'
        ? [
            createEditablePageHeroSection({
              id,
              title,
              ...(chrome.eyebrow ? { eyebrow: chrome.eyebrow } : {}),
              intro: chrome.intro ?? description,
              ...(chrome.heroMediaId ? { heroMediaId: chrome.heroMediaId } : {}),
            }),
          ]
        : []),
      createEditableHeaderSection(
        id,
        mediaId('/assets/point-logo.png'),
        template === 'home' ? 'overlay' : 'flow',
      ),
      ...elements.map(createCompatibilitySection),
    ],
  };
};

const pages: SiteDocument['pages'] = [
  page(
    0,
    'Home',
    '/',
    'Point Community Church in Manchaca, Texas.',
    [
      block({
        type: 'hero',
        variant: 'homeHero',
        heading:
          'We are a family of Jesus-followers empowered by the Holy Spirit to make disciples of Jesus in all of life for the glory of God',
        mediaId: mediaId('/assets/austin-skyline.jpeg'),
        align: 'center',
        surface: 'image',
        actions: [],
      }),
      block({
        type: 'heading',
        variant: 'homeIntro',
        eyebrow: 'Point ATX',
        text: 'A diverse group\nof ordinary people',
        level: 2,
        align: 'center',
        width: 'wide',
        supportingText:
          'We are a family of Jesus followers, empowered by the Spirit to make disciples of Jesus in all of life for the glory of God.',
        actions: [
          { label: 'Who we are', href: '/who-we-are', style: 'secondary' },
          { label: 'Our beliefs', href: '/what-we-believe', style: 'secondary' },
        ],
      }),
      block({
        type: 'splitFeature',
        variant: 'photoBanner',
        eyebrow: 'Life together',
        heading: 'Neighborhood Groups',
        body: 'Being the Church is more than a Sunday gathering. Discipleship happens in the everyday stuff of life within a community.',
        mediaId: mediaId('/assets/neighborhood-table.jpeg'),
        mediaAlt: 'Friends and families sharing a meal',
        mediaSide: 'left',
        proportion: 'half',
        align: 'center',
        surface: 'canvas',
        action: { label: 'Learn more', href: '/neighborhood-groups', style: 'primary' },
      }),
      block({
        type: 'splitFeature',
        variant: 'splitFeature',
        eyebrow: 'Kids ministry',
        heading: 'Next Generation',
        body: 'Kids are not the Church of tomorrow, but the Church today. Elementary-age kids and up worship with their parents in a multi-generational environment, while birth through preschool children have a safe, fun place to learn.',
        mediaId: mediaId('/assets/next-generation.jpeg'),
        mediaAlt: 'Families worshiping together at Point ATX',
        mediaSide: 'left',
        proportion: 'half',
        align: 'center',
        surface: 'canvas',
        action: { label: 'Learn more', href: '/next-generation', style: 'primary' },
      }),
      block({
        type: 'map',
        variant: 'gathering',
        eyebrow: 'Come as you are',
        heading: 'Gathering Times',
        body: 'Sunday Gatherings: 10:30 AM\n11300 Old San Antonio Rd., Manchaca, TX 78652',
        query: '11300 Old San Antonio Rd, Manchaca, TX 78652',
        title: 'Map to Point Community Church',
      }),
    ],
    { eyebrow: 'Point ATX', template: 'home' },
  ),
  page(
    1,
    'Who We Are',
    '/who-we-are',
    'We are a family of disciples on mission.',
    [
      block({
        type: 'cards',
        variant: 'splitEditorial',
        columns: 2,
        items: [
          {
            eyebrow: 'Our Gatherings',
            title: 'Worship Gathering',
            body: 'Every Sunday at 10:30am, we gather at 11300 Old San Antonio Rd. to celebrate what God has done for us in the Gospel of Jesus and what God is doing through us as a body of believers. Everyone is welcome.\n\nWe worship through singing, the study of the Bible and preaching, communion, testimonies of God’s faithfulness, baptism, and prayer.',
          },
          {
            eyebrow: 'Life together',
            title: 'Neighborhood Groups',
            body: 'A Neighborhood Group is a family of Jesus followers living together on God’s mission. It is a smaller expression of the church—ordinary people growing as disciples while making disciples in everyday life.\n\nOur groups meet at various times and places throughout the week.',
          },
        ],
      }),
      block({
        type: 'cards',
        variant: 'identity',
        eyebrow: 'Our Identity',
        heading: 'Family. Disciples. Mission.',
        columns: 3,
        items: [
          {
            title: 'Family',
            body: 'As children of God, we provide care and encouragement for one another.',
            supportingText: 'Ephesians 2:19–22',
          },
          {
            title: 'Disciples',
            body: 'We are Jesus-followers growing in the good news that God loves us, Jesus saves us, and the Spirit empowers us.',
            supportingText: '2 Corinthians 5:17–21',
          },
          {
            title: 'Mission',
            body: 'We all have a purpose to make more disciples by pointing others to Jesus.',
            supportingText: 'Matthew 28:18–20',
          },
        ],
      }),
      block({
        type: 'richText',
        variant: 'prose',
        eyebrow: 'More than a building',
        heading: 'What is the Church anyway?',
        content: [
          {
            type: 'paragraph',
            children: [
              {
                text: 'The Bible uses the word “church” to describe people connected to one another because of Jesus. While we have a building and gatherings, the church is not defined by a building we enter or an event we attend. We, the people, are the church.',
              },
            ],
          },
          {
            type: 'paragraph',
            children: [
              {
                text: 'God rescued his people through Jesus and calls the church to be his family living on his mission together. Joyfully living out the New Testament’s “one another” commands in light of the gospel is what we mean by being the church together.',
              },
            ],
          },
        ],
      }),
    ],
    {
      eyebrow: 'About Point',
      intro: 'We are a family of disciples on mission.',
      heroMediaId: mediaId('/assets/pages/who-we-are.jpeg'),
    },
  ),
  page(
    2,
    'Our Beliefs',
    '/what-we-believe',
    'Seven core beliefs form the foundation of our identity and practice.',
    [
      block({
        type: 'cards',
        variant: 'beliefs',
        eyebrow: 'Core Beliefs',
        columns: 2,
        items: beliefs.map(([title, body, references]) => ({
          title,
          body,
          supportingText: references,
        })),
      }),
      block({
        type: 'form',
        variant: 'panel',
        formId: formId('beliefs'),
        heading: 'Want to learn more?',
        supportingText: "We'd love to hear from you. Fill out the form below to get started.",
      }),
    ],
    {
      eyebrow: 'What We Believe',
      intro:
        'We hold to seven core beliefs as the foundation of our identity and practice as a local church. Regardless of your beliefs, you are welcome to learn with us.',
    },
  ),
  page(
    3,
    'Leadership',
    '/leadership',
    'Meet the leaders who equip our church family.',
    [
      block({
        type: 'people',
        variant: 'leadership',
        personIds: people.map((_, index) => uid(6_000 + index)),
        layout: 'grid',
      }),
      block({
        type: 'cards',
        variant: 'splitEditorialTone',
        heading: 'Leadership',
        columns: 2,
        items: [
          {
            eyebrow: 'Leadership',
            title: 'Structure',
            body: 'Jesus Christ is the head of the Church. At each local expression, he calls specific followers to provide leadership and care. Their primary role is to equip the church to be the church, not to take on the entire ministry of the congregation themselves.',
          },
          {
            eyebrow: 'Elders',
            title: 'Shared leadership',
            body: 'Elders are biblically qualified men who govern and teach sound doctrine. Point Community’s Elder Team leads together—equal in authority and accountability, unique in function, and unified in direction and vision.',
          },
        ],
      }),
      block({
        type: 'richText',
        variant: 'prose',
        eyebrow: 'Partnerships',
        heading: 'Serving Austin together',
        content: [
          {
            type: 'paragraph',
            children: [
              {
                text: 'The local church was not created to operate in isolation. Our strongest partnership is the Association of Hill Country Churches, committed to reaching every person in Greater Austin with the life-changing reality of Jesus.',
              },
            ],
          },
          {
            type: 'paragraph',
            children: [
              {
                text: 'Other partners include Christ Together Austin, Austin Church Planting Network, Austin Disaster Relief Network, TruCare Pregnancy Center, South Austin Young Life, Austin Bridge Builders Alliance, and Akins High School.',
              },
            ],
          },
        ],
      }),
    ],
    {
      eyebrow: 'Team & Staff',
      intro:
        'Meet the elders, ministry leaders, and staff who equip our church family to be the church.',
    },
  ),
  page(
    4,
    'Next Generation',
    '/next-generation',
    'Kids are not the Church of tomorrow, but the Church today.',
    [
      block({
        type: 'splitFeature',
        variant: 'imageSplit',
        eyebrow: 'First Point',
        heading: 'Next Generation\nKids Ministry',
        body: 'First Point is our ministry for our youngest children. The goal is to point children from birth through preschool toward the amazing love of God. Our volunteers love and serve these little lives week in and week out using the First Look curriculum.\n\nChildren are always welcome in the main gathering. If you need to step out with an infant, audio of the message is available in the lobby.',
        note: 'All volunteers are required to pass a background check before working in kids ministry.',
        mediaId: mediaId('/assets/pages/kids-ministry-2.jpeg'),
        mediaAlt: 'Point ATX kids ministry',
        mediaSide: 'left',
        proportion: 'half',
        align: 'center',
        surface: 'canvas',
        calloutLabel: 'Sunday Morning Child Care',
        calloutValue: '10:30am',
      }),
      block({
        type: 'image',
        variant: 'wide',
        mediaId: mediaId('/assets/pages/kids-ministry-3.jpeg'),
        alt: 'Children and families at Point ATX',
        aspect: 'natural',
        fit: 'cover',
      }),
      block({
        type: 'form',
        variant: 'panel',
        formId: formId('kids'),
        heading: 'Contact Us',
        supportingText: "We'd love to answer your questions about kids ministry.",
      }),
    ],
    {
      eyebrow: 'Kids Ministry',
      intro: 'We believe kids are not the Church of tomorrow, but the Church today.',
      heroMediaId: mediaId('/assets/pages/kids-ministry-1.jpeg'),
    },
  ),
  page(
    5,
    'Connect Card',
    '/connect-card',
    "We're glad you're here. Tell us a little about yourself so we can help you get connected.",
    [
      block({
        type: 'form',
        variant: 'standalone',
        formId: formId('connect-card'),
        heading: 'Connect Card',
      }),
    ],
    { eyebrow: 'Welcome to our family' },
  ),
  page(
    6,
    'Neighborhood Groups',
    '/neighborhood-groups',
    'Smaller groups where we can be the church together.',
    [
      block({
        type: 'cards',
        variant: 'groups',
        columns: 3,
        items: groups.map(([title, schedule, location, leaders]) => ({
          title,
          body: `${schedule}\n${location}\nLeaders: ${leaders}`,
        })),
      }),
      block({
        type: 'form',
        variant: 'panel',
        formId: formId('groups'),
        heading: 'Live in community with a mission',
        supportingText: 'Submit this form and we will help you find a Neighborhood Group near you.',
      }),
      block({
        type: 'faq',
        variant: 'groups',
        eyebrow: 'Common questions',
        heading: 'Finding your group',
        items: groupFaqs.map(([question, answer]) => ({ question, answer })),
      }),
    ],
    {
      eyebrow: 'Church in everyday life',
      intro:
        'Neighborhood Groups are smaller groups where we can be the church together in the places we live, work, play, and learn.',
      heroMediaId: mediaId('/assets/pages/neighborhood-map.png'),
    },
  ),
  page(
    7,
    'Prayer Requests',
    '/prayer-request',
    'Our team prays for every request we receive on a regular basis.',
    [
      block({
        type: 'form',
        variant: 'standalone',
        formId: formId('prayer-request'),
        heading: 'Prayer Request Form',
      }),
    ],
    { eyebrow: 'We would be honored to pray' },
  ),
  page(
    8,
    'Giving',
    '/give',
    'God is generous, and so he calls us to be as well.',
    [
      block({
        type: 'richText',
        variant: 'prose',
        eyebrow: 'Why we give',
        heading: 'Generosity is worship',
        content: [
          {
            type: 'paragraph',
            children: [
              {
                text: 'What we do with what God has given us shows the world where our hearts are and helps proclaim the gospel. We want to glorify God with every area of our lives, including our finances.',
              },
            ],
          },
        ],
      }),
      block({
        type: 'cards',
        variant: 'giving',
        columns: 2,
        items: [
          {
            title: 'Give Online',
            body: 'Give a one-time donation or set up a recurring gift securely through our current giving partner.',
            href: 'https://subsplash.com/u/-W69J2R/give',
          },
          {
            title: 'Give In Person',
            body: 'A giving box is available in the back of the sanctuary for cash and check donations.',
          },
        ],
      }),
      block({
        type: 'form',
        variant: 'panel',
        formId: formId('giving'),
        heading: 'Have questions or need help?',
        supportingText: "We'd love to hear from you.",
      }),
    ],
    { eyebrow: 'Generosity', heroMediaId: mediaId('/assets/pages/giving.png') },
  ),
  page(
    9,
    'Contact Us',
    '/contact',
    'If you have questions or would like more information about Point ATX, we would love to hear from you.',
    [
      block({
        type: 'form',
        variant: 'contact',
        formId: formId('contact'),
        heading: 'Monday–Friday\n9am–5pm',
        supportingText: 'Fill out the form and we will get back to you as soon as possible.',
        eyebrow: 'Office Hours',
        body: 'connect@pointaustin.org\n11300 Old San Antonio Rd, Manchaca, TX 78652',
        linkLabel: 'Get directions →',
        linkHref: 'https://maps.google.com/?q=11300+Old+San+Antonio+Rd+Manchaca+TX+78652',
      }),
      block({
        type: 'cta',
        variant: 'rental',
        eyebrow: 'Need a space?',
        heading: 'Building Rental',
        action: { label: 'Request the building', href: '/building-rental', style: 'primary' },
        surface: 'surface',
      }),
    ],
    { eyebrow: 'Get in touch' },
  ),
  page(
    10,
    'Building Rental',
    '/building-rental',
    'Tell us about your organization and the date, time, and length of your requested rental.',
    [
      block({
        type: 'form',
        variant: 'standalone',
        formId: formId('building-rental'),
        heading: 'Building Rental Request',
      }),
    ],
    { eyebrow: 'Request the space' },
  ),
];

const rawDocument = {
  schemaVersion: SCHEMA_VERSION,
  rendererVersion: RENDERER_VERSION,
  site: {
    name: 'Point Community Church',
    shortName: 'Point ATX',
    mission:
      'We are a family of Jesus-followers empowered by the Holy Spirit to make disciples of Jesus in all of life for the glory of God',
    email: 'connect@pointaustin.org',
    address: {
      street: '11300 Old San Antonio Rd',
      city: 'Manchaca',
      region: 'TX',
      postalCode: '78652',
    },
    service: { label: 'Sunday Gathering', schedule: 'Sunday at 10:30 AM' },
    givingUrl: 'https://subsplash.com/u/-W69J2R/give',
    socialLinks: [
      {
        platform: 'facebook',
        label: 'Point ATX on Facebook',
        url: 'https://www.facebook.com/pointatx/',
      },
      {
        platform: 'instagram',
        label: 'Point ATX on Instagram',
        url: 'https://www.instagram.com/pointatx/',
      },
    ],
  },
  theme: {
    preset: 'point-classic',
    colors: {
      canvas: '#ffffff',
      surface: '#f3f1eb',
      text: '#171a17',
      mutedText: '#60665e',
      primary: '#3e522c',
      onPrimary: '#ffffff',
      border: '#d9d9d2',
    },
    headingFont: 'sans',
    bodyFont: 'sans',
    spacingDensity: 'comfortable',
    radius: 'square',
    buttonStyle: 'solid',
    surfaceStyle: 'warm',
  },
  navigation: [
    {
      id: uid(7_001),
      label: 'About',
      href: '/who-we-are',
      children: [
        { id: uid(7_002), label: 'Who We Are', href: '/who-we-are' },
        { id: uid(7_003), label: 'What We Believe', href: '/what-we-believe' },
        { id: uid(7_004), label: 'Leadership', href: '/leadership' },
        { id: uid(7_005), label: 'Next Generation', href: '/next-generation' },
      ],
    },
    {
      id: uid(7_006),
      label: 'Connect',
      href: '/connect-card',
      children: [
        { id: uid(7_007), label: 'Connect Card', href: '/connect-card' },
        { id: uid(7_008), label: 'Neighborhood Groups', href: '/neighborhood-groups' },
        { id: uid(7_009), label: 'Prayer Request', href: '/prayer-request' },
      ],
    },
    { id: uid(7_010), label: 'Give', href: '/give', children: [] },
    { id: uid(7_011), label: 'Contact', href: '/contact', children: [] },
  ],
  pages,
  forms: forms.map(({ id, name, recipientEmail, subject, submitLabel, fields }) => ({
    id,
    name,
    recipientEmail,
    subject,
    submitLabel,
    fields,
  })),
  media: mediaRecords,
  linkedMedia: [],
  collections: {
    people: people.map(([name, role, sourcePath], index) => ({
      id: uid(6_000 + index),
      name,
      role,
      bio: `${name} serves Point Community Church.`,
      mediaId: mediaId(sourcePath),
      mediaAlt: name,
    })),
    beliefs: beliefs.map(([title, body, references], index) => ({
      id: uid(8_000 + index),
      title,
      body,
      references,
    })),
    groups: groups.map(([name, schedule, location, leaders], index) => ({
      id: uid(9_000 + index),
      name,
      description: 'A Point Community Church Neighborhood Group.',
      status: 'active',
      schedule,
      location,
      leaders,
    })),
    events: [],
  },
};

export const defaultSiteDocument: SiteDocument = SiteDocumentSchema.parse(rawDocument);
