import { isDirectVideoUrl, youtubeEmbedUrl, youtubeVideoId } from '../../src/site-kit/linked-media';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { IDS, validSiteDocument } from '../fixtures/site-documents';

describe('linked media', () => {
  it.each([
    ['https://youtu.be/M7lc1UVf-VE', 'M7lc1UVf-VE'],
    ['https://www.youtube.com/watch?v=M7lc1UVf-VE', 'M7lc1UVf-VE'],
    ['https://youtube.com/shorts/M7lc1UVf-VE', 'M7lc1UVf-VE'],
  ])('recognizes supported YouTube link %s', (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
    expect(youtubeEmbedUrl(url)).toBe(`https://www.youtube-nocookie.com/embed/${id}`);
  });

  it('rejects lookalike YouTube hosts and non-video direct links', () => {
    expect(youtubeVideoId('https://youtube.com.evil.test/watch?v=M7lc1UVf-VE')).toBeNull();
    expect(isDirectVideoUrl('https://media.example.com/watch')).toBe(false);
    expect(isDirectVideoUrl('https://media.example.com/point.webm')).toBe(true);
  });

  it('validates accessible images and allowlisted video shapes in the document', () => {
    const image = structuredClone(validSiteDocument) as unknown as {
      linkedMedia: Array<Record<string, unknown>>;
    };
    image.linkedMedia = [
      {
        id: IDS.linkedMedia,
        type: 'image',
        url: 'https://media.example.com/point.jpg',
        displayName: 'Point',
        alternativeText: 'Point gathering',
        tags: [],
      },
    ];
    expect(SiteDocumentSchema.safeParse(image).success).toBe(true);
    const inaccessible = structuredClone(image);
    delete inaccessible.linkedMedia[0].alternativeText;
    expect(SiteDocumentSchema.safeParse(inaccessible).success).toBe(false);
    inaccessible.linkedMedia[0] = {
      id: IDS.linkedMedia,
      type: 'youtube',
      url: 'https://example.com/video',
      displayName: 'Wrong host',
      tags: [],
    };
    expect(SiteDocumentSchema.safeParse(inaccessible).success).toBe(false);
  });
});
