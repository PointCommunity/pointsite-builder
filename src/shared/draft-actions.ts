import { z } from 'zod';

export const DraftActionCategorySchema = z.enum([
  'text-edit',
  'control-change',
  'add',
  'remove',
  'duplicate',
  'reorder',
  'move',
  'resize',
  'replace',
  'undo',
  'redo',
  'restore',
]);

export const DraftActionContextSchema = z.enum([
  'page-content',
  'page-details',
  'page-structure',
  'forms',
  'library-attachment',
  'linked-media',
  'navigation',
  'theme',
  'site-settings',
  'collections',
  'section-settings',
  'element-settings',
  'element-layout',
  'revision-history',
  'draft',
]);

export const DraftActionSchema = z.strictObject({
  category: DraftActionCategorySchema,
  context: DraftActionContextSchema,
});

export type DraftActionCategory = z.infer<typeof DraftActionCategorySchema>;
export type DraftActionContext = z.infer<typeof DraftActionContextSchema>;
export type DraftAction = z.infer<typeof DraftActionSchema>;

const categoryLabels: Record<DraftActionCategory, string> = {
  'text-edit': 'Edited text',
  'control-change': 'Changed a setting',
  add: 'Added content',
  remove: 'Removed content',
  duplicate: 'Duplicated content',
  reorder: 'Reordered content',
  move: 'Moved content',
  resize: 'Resized content',
  replace: 'Replaced content',
  undo: 'Undid a change',
  redo: 'Redid a change',
  restore: 'Restored a revision',
};

const contextLabels: Record<DraftActionContext, string> = {
  'page-content': 'Page content',
  'page-details': 'Page details',
  'page-structure': 'Page structure',
  forms: 'Forms',
  'library-attachment': 'Library attachment',
  'linked-media': 'Linked media',
  navigation: 'Navigation',
  theme: 'Theme',
  'site-settings': 'Site settings',
  collections: 'Collections',
  'section-settings': 'Section settings',
  'element-settings': 'Element settings',
  'element-layout': 'Element layout',
  'revision-history': 'Revision history',
  draft: 'Draft',
};

export function draftActionCategoryLabel(value: DraftActionCategory | null): string {
  return value ? categoryLabels[value] : 'Legacy save';
}

export function draftActionContextLabel(value: DraftActionContext | null): string {
  return value ? contextLabels[value] : 'Earlier Builder version';
}
