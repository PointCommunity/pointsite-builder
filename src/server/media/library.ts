import { checksumDocument } from '../../site-kit/canonicalize';
import { SiteDocumentSchema } from '../../site-kit/schema';
import type { SiteDocument } from '../../site-kit/types';
import type {
  LibraryItem,
  LibraryLinkInput,
  LibraryMetadata,
  LibraryMutationContext,
  LibraryMutationResult,
  LibrarySnapshot,
} from '../../shared/library';
import type { DraftRecord } from '../repositories/contracts';
import type { D1DraftRepository } from '../repositories/d1';
import { ConflictError, NotFoundError } from '../repositories/memory';
import type { D1DraftAssets } from './draft-assets';
import { validateImageUpload } from './policy';
import { defaultSiteDocument } from '../../site-kit/default-site';

const managedIds = new Set(defaultSiteDocument.media.map((item) => item.id));

interface ItemRow {
  item_id: string;
  item_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}
type CommandContext = LibraryMutationContext & { actor: string; requestId: string };
type ImageInput = { filename: string; contentType: string; bytes: Uint8Array; altText: string };
type Command =
  | { action: 'upload'; image: ImageInput }
  | { action: 'link'; link: LibraryLinkInput }
  | { action: 'archive' | 'unarchive' | 'delete'; itemId: string }
  | { action: 'update'; itemId: string; metadata: LibraryMetadata }
  | { action: 'replace'; itemId: string; image: ImageInput; metadata: LibraryMetadata };

/** Count placements only: catalog membership is handled separately for retained revisions. */
export function libraryUsage(document: SiteDocument, itemId: string): number {
  const visit = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce<number>((sum, child) => sum + visit(child), 0);
    if (!value || typeof value !== 'object') return 0;
    return Object.entries(value).reduce(
      (sum, [key, child]) =>
        sum +
        ((key === 'mediaId' || key.endsWith('MediaId')) && child === itemId ? 1 : visit(child)),
      0,
    );
  };
  return Object.entries(document).reduce(
    (sum, [key, value]) => sum + (key === 'media' || key === 'linkedMedia' ? 0 : visit(value)),
    0,
  );
}

function documentItems(draft: DraftRecord): LibraryItem[] {
  const common = {
    createdAt: draft.createdAt,
    updatedAt: draft.createdAt,
    archivedAt: null,
    usageCount: 0,
    deleteBlockers: [],
  };
  return [
    ...draft.document.media.map((item): LibraryItem => ({
      ...common,
      id: item.id,
      mediaType: 'image',
      sourceType:
        managedIds.has(item.id) || !item.sourcePath.startsWith('/assets/builder/')
          ? 'managed'
          : 'uploaded',
      displayName: item.displayName || item.alt || item.sourcePath.split('/').pop() || 'Image',
      filename: item.sourcePath.split('/').pop() || '',
      sourcePath: item.sourcePath,
      url: item.sourcePath,
      altText: item.alt,
      tags: item.tags ?? [],
    })),
    ...draft.document.linkedMedia.map((item): LibraryItem => ({
      ...common,
      id: item.id,
      mediaType: item.type,
      sourceType: 'linked',
      displayName: item.displayName,
      filename: '',
      sourcePath: '',
      url: item.url,
      altText: item.alternativeText ?? '',
      tags: item.tags ?? [],
    })),
  ];
}

export class D1LibraryService {
  constructor(
    private readonly database: D1Database,
    private readonly repository: D1DraftRepository,
    private readonly assets: D1DraftAssets,
  ) {}

  async list(draftId: string): Promise<LibrarySnapshot> {
    const draft = await this.repository.getDraft(draftId);
    const rows = await this.database
      .prepare(
        'SELECT item_id,item_json,created_at,updated_at,archived_at FROM draft_library_items WHERE draft_id=?',
      )
      .bind(draftId)
      .all<ItemRow>();
    const current = documentItems(draft);
    const items = new Map(
      rows.results.map((row) => [
        row.item_id,
        {
          ...(JSON.parse(row.item_json) as LibraryItem),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          archivedAt: row.archived_at,
        },
      ]),
    );
    // Revision timestamps provide a deterministic baseline for legacy catalog records.
    const historyRows = await this.database
      .prepare(
        `WITH entries AS (
        SELECT json_extract(item.value,'$.id') AS item_id,r.sequence,r.created_at,
          item.value AS signature,json_extract(item.value,'$.sourcePath') AS source_path
        FROM revisions r,json_each(r.document_json,'$.media') item WHERE r.draft_id=?
        UNION ALL
        SELECT json_extract(item.value,'$.id'),r.sequence,r.created_at,item.value,NULL
        FROM revisions r,json_each(r.document_json,'$.linkedMedia') item WHERE r.draft_id=?
      ), changes AS (
        SELECT *,LAG(signature) OVER (PARTITION BY item_id ORDER BY sequence) AS previous
        FROM entries
      )
      SELECT 'item' AS kind,item_id,MIN(created_at) AS created_at,
        MAX(CASE WHEN previous IS NULL OR previous<>signature THEN created_at END) AS updated_at,
        NULL AS source_path FROM changes GROUP BY item_id
      UNION ALL
      SELECT DISTINCT 'path',NULL,NULL,NULL,source_path FROM entries WHERE source_path IS NOT NULL`,
      )
      .bind(draftId, draftId)
      .all<{
        kind: 'item' | 'path';
        item_id: string;
        created_at: string;
        updated_at: string;
        source_path: string;
      }>();
    const history = new Map<string, { createdAt: string; updatedAt: string }>();
    const retainedPaths = new Set<string>();
    for (const row of historyRows.results) {
      if (row.kind === 'path') retainedPaths.add(row.source_path);
      else history.set(row.item_id, { createdAt: row.created_at, updatedAt: row.updated_at });
    }
    const versions = await this.database
      .prepare(
        'SELECT m.item_id,v.source_path FROM draft_library_asset_versions m JOIN draft_asset_versions v ON v.id=m.asset_id WHERE m.draft_id=?',
      )
      .bind(draftId)
      .all<{ item_id: string; source_path: string }>();
    for (const item of current) {
      const stored = items.get(item.id);
      const dates = history.get(item.id);
      items.set(item.id, {
        ...stored,
        ...item,
        filename: stored?.filename ?? item.filename,
        sourceType: stored?.sourceType ?? item.sourceType,
        createdAt: stored?.createdAt ?? dates?.createdAt ?? draft.createdAt,
        updatedAt:
          [stored?.updatedAt, dates?.updatedAt]
            .filter((date): date is string => Boolean(date))
            .sort()
            .at(-1) ?? draft.createdAt,
        archivedAt: stored?.archivedAt ?? null,
      });
    }
    for (const item of items.values()) {
      if (item.sourcePath)
        item.url = `/api/drafts/${draftId}/assets?path=${encodeURIComponent(item.sourcePath)}`;
      item.usageCount = libraryUsage(draft.document, item.id);
      item.deleteBlockers = [];
      if (item.usageCount)
        item.deleteBlockers.push(
          `Used in ${item.usageCount} current placement${item.usageCount === 1 ? '' : 's'}. Remove those placements first.`,
        );
      if (
        history.has(item.id) ||
        retainedPaths.has(item.sourcePath) ||
        versions.results.some(
          (version) => version.item_id === item.id && retainedPaths.has(version.source_path),
        )
      )
        item.deleteBlockers.push(
          'Retained draft revisions contain this item. It remains protected while those revisions are retained. Deleting the entire archived draft removes its history and contents.',
        );
    }
    const result = [...items.values()];
    if (current.some((item) => !rows.results.some((row) => row.item_id === item.id))) {
      await this.database
        .prepare(
          `INSERT OR IGNORE INTO draft_library_items (draft_id,item_id,item_json,created_at,updated_at,archived_at) SELECT ?,json_extract(value,'$.id'),value,json_extract(value,'$.createdAt'),json_extract(value,'$.updatedAt'),NULL FROM json_each(?) WHERE EXISTS (SELECT 1 FROM drafts WHERE id=?)`,
        )
        .bind(draftId, JSON.stringify(result.filter((item) => !item.archivedAt)), draftId)
        .run();
    }
    return {
      draftId,
      revisionId: draft.latestRevisionId,
      revisionChecksum: draft.revision.checksum,
      items: result,
      activeCount: result.filter((item) => !item.archivedAt).length,
      archivedCount: result.filter((item) => item.archivedAt).length,
    };
  }

  async mutate(context: CommandContext, command: Command): Promise<LibraryMutationResult> {
    await this.repository.assertCheckout(context.draftId, context.actor, context.checkoutToken);
    const draft = await this.repository.getDraft(context.draftId);
    if (draft.status !== 'active') throw new ConflictError('Only active drafts can be changed');
    const hashable =
      'image' in command
        ? {
            ...command,
            image: {
              ...command.image,
              bytes: Array.from(
                new Uint8Array(
                  await crypto.subtle.digest(
                    'SHA-256',
                    Uint8Array.from(command.image.bytes).buffer,
                  ),
                ),
                (byte) => byte.toString(16).padStart(2, '0'),
              ).join(''),
            },
          }
        : command;
    const commandHash = await checksumDocument(hashable);
    const prior = await this.database
      .prepare(
        'SELECT command_hash FROM draft_library_operations WHERE draft_id=? AND actor=? AND idempotency_key=?',
      )
      .bind(context.draftId, context.actor.toLowerCase(), context.idempotencyKey)
      .first<{ command_hash: string }>();
    if (prior) {
      if (prior.command_hash !== commandHash)
        throw new ConflictError('This request key already belongs to another Library action');
      return { draft, library: await this.list(context.draftId) };
    }
    if (draft.revision.checksum !== context.expectedChecksum)
      throw new ConflictError('The draft has a newer revision');
    if (draft.latestRevisionId !== context.expectedRevisionId)
      throw new ConflictError('The draft Library has a newer revision');
    const snapshot = await this.list(draft.id);
    let item =
      'itemId' in command
        ? snapshot.items.find((candidate) => candidate.id === command.itemId)
        : undefined;
    if ('itemId' in command && !item)
      throw new NotFoundError('Library item was not found in this draft');
    const document = structuredClone(draft.document);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    const preparedPaths = new Set<string>();
    if (command.action === 'upload' || command.action === 'replace') {
      if (command.action === 'replace' && (item?.mediaType !== 'image' || item.archivedAt))
        throw new ConflictError('Only active images can be replaced');
      try {
        validateImageUpload(command.image);
      } catch (error) {
        throw new Error(
          `MEDIA_REJECTED: ${error instanceof Error ? error.message : 'Invalid image'}`,
        );
      }
      const prepared = await this.assets.prepareImage(draft.id, command.image.bytes, {
        ...command.image,
        actor: context.actor,
        now,
      });
      const duplicates = await this.database
        .prepare(
          'SELECT b.source_path FROM draft_asset_versions v JOIN draft_asset_bindings b ON b.asset_id=v.id AND b.draft_id=v.draft_id WHERE v.draft_id=? AND v.checksum=? AND v.byte_size=?',
        )
        .bind(draft.id, prepared.checksum, prepared.byteSize)
        .all<{ source_path: string }>();
      if (
        snapshot.items.some(
          (candidate) =>
            duplicates.results.some(
              (duplicate) => candidate.sourcePath === duplicate.source_path,
            ) && candidate.id !== item?.id,
        )
      )
        throw new ConflictError(
          'This image already exists in this draft Library. Use its existing item.',
        );
      statements.push(...prepared.statements);
      preparedPaths.add(prepared.sourcePath);
      if (item?.sourcePath)
        statements.push(
          this.database
            .prepare(
              `INSERT OR IGNORE INTO draft_library_asset_versions (draft_id,item_id,asset_id) SELECT ?,?,asset_id FROM draft_asset_bindings WHERE draft_id=? AND source_path=?`,
            )
            .bind(draft.id, item.id, draft.id, item.sourcePath),
        );
      const metadata =
        command.action === 'replace'
          ? command.metadata
          : {
              displayName:
                command.image.filename
                  .replace(/\.[^.]+$/, '')
                  .trim()
                  .slice(0, 120) || 'Image',
              altText: command.image.altText.trim(),
              tags: [],
            };
      const id = item?.id ?? crypto.randomUUID();
      statements.push(
        this.database
          .prepare(
            'INSERT INTO draft_library_asset_versions (draft_id,item_id,asset_id) VALUES (?,?,?)',
          )
          .bind(draft.id, id, prepared.assetId),
      );
      item = {
        id,
        mediaType: 'image',
        sourceType: 'uploaded',
        filename: command.image.filename,
        sourcePath: prepared.sourcePath,
        url: prepared.sourcePath,
        ...metadata,
        createdAt: item?.createdAt ?? now,
        updatedAt: now,
        archivedAt: null,
        usageCount: item?.usageCount ?? 0,
        deleteBlockers: [],
        width: prepared.width,
        height: prepared.height,
        byteSize: prepared.byteSize,
      };
      document.media = document.media.filter((entry) => entry.id !== id);
      document.media.push({
        id,
        sourcePath: prepared.sourcePath,
        alt: metadata.altText,
        displayName: metadata.displayName,
        tags: metadata.tags,
      });
      document.linkedMedia = document.linkedMedia.filter((entry) => entry.id !== id);
      this.replaceLinkedPlacements(document, id, metadata.altText);
    } else if (command.action === 'link') {
      const id = crypto.randomUUID();
      const link = command.link;
      document.linkedMedia.push({
        id,
        type: link.mediaType,
        url: link.url,
        displayName: link.displayName,
        ...(link.altText ? { alternativeText: link.altText } : {}),
        tags: link.tags,
      });
      item = {
        id,
        ...link,
        filename: '',
        sourcePath: '',
        sourceType: 'linked',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        usageCount: 0,
        deleteBlockers: [],
      };
    } else if (item) {
      if (command.action === 'delete') {
        if (!item.archivedAt) throw new ConflictError('Archive this item before deleting it');
        if (item.deleteBlockers.length) throw new ConflictError(item.deleteBlockers.join(' '));
        statements.push(
          this.database
            .prepare('DELETE FROM draft_library_items WHERE draft_id=? AND item_id=?')
            .bind(draft.id, item.id),
        );
        // Unreferenced binary versions belong exclusively to this draft and item paths.
        if (item.sourcePath)
          statements.push(
            this.database
              .prepare(
                `DELETE FROM draft_asset_versions WHERE draft_id=? AND (id IN (SELECT asset_id FROM draft_asset_bindings WHERE draft_id=? AND source_path=?) OR id IN (SELECT asset_id FROM draft_library_asset_versions WHERE draft_id=? AND item_id=?))`,
              )
              .bind(draft.id, draft.id, item.sourcePath, draft.id, item.id),
          );
      } else {
        if (command.action === 'update') {
          item = { ...item, ...command.metadata, updatedAt: now };
          const image = document.media.find((entry) => entry.id === item?.id);
          if (image)
            Object.assign(image, {
              alt: item.altText,
              displayName: item.displayName,
              tags: item.tags,
            });
          const link = document.linkedMedia.find((entry) => entry.id === item?.id);
          if (link)
            Object.assign(link, {
              alternativeText: item.altText,
              displayName: item.displayName,
              tags: item.tags,
            });
        } else {
          item = { ...item, archivedAt: command.action === 'archive' ? now : null, updatedAt: now };
          if (command.action === 'archive' && !item.usageCount) {
            document.media = document.media.filter((entry) => entry.id !== item?.id);
            document.linkedMedia = document.linkedMedia.filter((entry) => entry.id !== item?.id);
          } else if (command.action === 'unarchive' && !this.contains(document, item.id)) {
            if (item.sourceType === 'linked')
              document.linkedMedia.push({
                id: item.id,
                type: item.mediaType,
                url: item.url,
                displayName: item.displayName,
                ...(item.altText ? { alternativeText: item.altText } : {}),
                tags: item.tags,
              });
            else
              document.media.push({
                id: item.id,
                sourcePath: item.sourcePath,
                alt: item.altText,
                displayName: item.displayName,
                tags: item.tags,
              });
          }
        }
      }
    }
    if (item && command.action !== 'delete')
      statements.push(
        this.database
          .prepare(
            `INSERT INTO draft_library_items (draft_id,item_id,item_json,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?) ON CONFLICT(draft_id,item_id) DO UPDATE SET item_json=excluded.item_json,updated_at=excluded.updated_at,archived_at=excluded.archived_at`,
          )
          .bind(
            draft.id,
            item.id,
            JSON.stringify(item),
            item.createdAt,
            item.updatedAt,
            item.archivedAt,
          ),
      );
    statements.push(
      this.database
        .prepare(
          'INSERT INTO draft_library_operations (draft_id,actor,idempotency_key,command_hash) VALUES (?,?,?,?)',
        )
        .bind(draft.id, context.actor.toLowerCase(), context.idempotencyKey, commandHash),
    );
    statements.push(
      this.database
        .prepare(
          "INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?,?,?,?,?,?,'succeeded',?,'{}')",
        )
        .bind(
          crypto.randomUUID(),
          now,
          context.actor,
          `library.${command.action}`,
          'draft',
          draft.id,
          context.requestId,
        ),
    );
    const saved = await this.repository.saveDraft(
      {
        draftId: draft.id,
        expectedRevisionId: context.expectedRevisionId,
        expectedChecksum: context.expectedChecksum,
        document: SiteDocumentSchema.parse(document),
        actor: context.actor,
        checkoutToken: context.checkoutToken,
        idempotencyKey: await checksumDocument({
          scope: 'library',
          draftId: draft.id,
          key: context.idempotencyKey,
        }),
        requestId: context.requestId,
        action: {
          category:
            command.action === 'replace'
              ? 'replace'
              : command.action === 'upload' || command.action === 'link'
                ? 'add'
                : command.action === 'delete' || command.action === 'archive'
                  ? 'remove'
                  : 'control-change',
          context: 'library-attachment',
        },
      },
      statements,
      preparedPaths,
    );
    return { draft: saved, library: await this.list(draft.id) };
  }

  private contains(document: SiteDocument, id: string) {
    return (
      document.media.some((item) => item.id === id) ||
      document.linkedMedia.some((item) => item.id === id)
    );
  }
  private replaceLinkedPlacements(document: SiteDocument, id: string, alt: string) {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (record.type === 'mediaEmbed' && record.linkedMediaId === id) {
        record.type = 'image';
        record.mediaId = id;
        record.alt = alt;
        delete record.linkedMediaId;
      }
      if (record.type === 'image' && record.mediaId === id) record.alt = alt;
      Object.values(record).forEach(visit);
    };
    visit(document.pages);
  }
}
