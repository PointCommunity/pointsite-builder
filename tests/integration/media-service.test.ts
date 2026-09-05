// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await -- in-memory test doubles intentionally mirror async storage */
import {
  MediaService,
  type MediaRepository,
  type MediaRecord,
  type PrivateBucket,
} from '../../src/server/media/service';

function png() {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 320);
  view.setUint32(20, 200);
  return bytes;
}

class MemoryMedia implements MediaRepository {
  items: MediaRecord[] = [];
  async list() {
    return structuredClone(this.items);
  }
  async findDuplicate(checksum: string, byteSize: number) {
    return structuredClone(
      this.items.find((item) => item.checksum === checksum && item.byteSize === byteSize) ?? null,
    );
  }
  async get(id: string) {
    return structuredClone(this.items.find((item) => item.id === id) ?? null);
  }
  async totalBytes() {
    return this.items.reduce((total, item) => total + item.byteSize, 0);
  }
  async create(record: MediaRecord) {
    this.items.push(structuredClone(record));
  }
  async markOrphaned() {
    return 0;
  }
  async deleteOrphans() {
    return [];
  }
}

it('stores validated bytes privately and deduplicates identical uploads', async () => {
  const repository = new MemoryMedia();
  const objects = new Map<string, Uint8Array>();
  const bucket: PrivateBucket = {
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => {
      objects.delete(key);
    },
  };
  const service = new MediaService(repository, bucket);
  const input = {
    filename: 'table.png',
    contentType: 'image/png',
    bytes: png(),
    altText: 'People sharing a meal',
    actor: 'editor@pointatx.org',
    requestId: 'request-1',
  };
  const first = await service.upload(input);
  const second = await service.upload({ ...input, requestId: 'request-2' });
  expect(first.status).toBe('ready');
  expect(second.id).toBe(first.id);
  expect(repository.items).toHaveLength(1);
  expect(objects.size).toBe(1);
  await expect(service.read(first.id)).resolves.toMatchObject({ contentType: 'image/png' });
});
