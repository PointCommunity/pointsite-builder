// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await -- in-memory test doubles intentionally mirror async storage */
import { createApp } from '../../src/server';
import {
  MediaService,
  type MediaRecord,
  type MediaRepository,
  type PrivateBucket,
} from '../../src/server/media/service';
import { InMemoryRepository } from '../../src/server/repositories/memory';

class MemoryMedia implements MediaRepository {
  items: MediaRecord[] = [];
  async list() {
    return this.items;
  }
  async findDuplicate(checksum: string, size: number) {
    return this.items.find((item) => item.checksum === checksum && item.byteSize === size) ?? null;
  }
  async get(id: string) {
    return this.items.find((item) => item.id === id) ?? null;
  }
  async create(record: MediaRecord) {
    this.items.push(record);
  }
  async markOrphaned() {
    return 0;
  }
  async deleteOrphans() {
    return [];
  }
}
function image() {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 100);
  view.setUint32(20, 80);
  return bytes;
}

function fixture(role: 'viewer' | 'editor') {
  const repository = new MemoryMedia();
  const objects = new Map<string, Uint8Array>();
  const bucket: PrivateBucket = {
    put: async (k, b) => {
      objects.set(k, b);
    },
    get: async (k) => objects.get(k) ?? null,
    delete: async (k) => {
      objects.delete(k);
    },
  };
  const app = createApp({
    repository: new InMemoryRepository(),
    media: new MediaService(repository, bucket),
    authenticate: () => Promise.resolve({ email: `${role}@pointatx.org`, role }),
    environment: 'test',
    version: 'test',
  });
  return { app, repository };
}

it('allows an editor to upload and an authenticated viewer to read private media', async () => {
  const { app, repository } = fixture('editor');
  const form = new FormData();
  form.set('altText', 'Point gathering');
  form.set('file', new File([image()], 'point.png', { type: 'image/png' }));
  const uploaded = await app.request('https://builder.pointatx.org/api/media', {
    method: 'POST',
    headers: {
      origin: 'https://builder.pointatx.org',
      'sec-fetch-site': 'same-origin',
      'idempotency-key': 'media-upload-0001',
    },
    body: form,
  });
  expect(uploaded.status).toBe(201);
  expect(repository.items).toHaveLength(1);
  const read = await app.request(
    `https://builder.pointatx.org/api/media/${repository.items[0]?.id}`,
  );
  expect(read.status).toBe(200);
  expect(read.headers.get('content-type')).toBe('image/png');
});

it('denies media upload to a viewer', async () => {
  const { app } = fixture('viewer');
  const form = new FormData();
  form.set('altText', 'Alt');
  form.set('file', new File([image()], 'point.png', { type: 'image/png' }));
  const response = await app.request('https://builder.pointatx.org/api/media', {
    method: 'POST',
    headers: {
      origin: 'https://builder.pointatx.org',
      'sec-fetch-site': 'same-origin',
      'idempotency-key': 'media-upload-0002',
    },
    body: form,
  });
  expect(response.status).toBe(403);
});
