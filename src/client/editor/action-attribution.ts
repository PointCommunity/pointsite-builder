import type { DraftActionCategory, DraftActionContext } from '../../shared/draft-actions';
import type { AutosaveMutation } from './action-autosave';

const fieldKeys = new WeakMap<Element, string>();
let fieldSequence = 0;

function fieldKey(element: Element): string {
  const known = fieldKeys.get(element);
  if (known) return known;
  fieldSequence += 1;
  const key = `field-${fieldSequence}`;
  fieldKeys.set(element, key);
  return key;
}

function buttonCategory(element: HTMLButtonElement): DraftActionCategory {
  const cue = `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`
    .trim()
    .toLowerCase();
  if (/\bundo\b/.test(cue)) return 'undo';
  if (/\bredo\b/.test(cue)) return 'redo';
  if (/\bduplicate|\bcopy\b/.test(cue)) return 'duplicate';
  if (/\bremove|\bdelete\b/.test(cue)) return 'remove';
  if (/\bmove|\breorder|\bearlier|\blater|\bup\b|\bdown\b/.test(cue)) return 'reorder';
  if (/\badd\b|\bnew\b|\binsert\b/.test(cue)) return 'add';
  return 'control-change';
}

export function mutationForContext(
  context: DraftActionContext,
  category?: DraftActionCategory,
): AutosaveMutation {
  if (category) return { category, context };
  const element = globalThis.document?.activeElement;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const inputType = element instanceof HTMLInputElement ? element.type : 'textarea';
    if (['text', 'search', 'url', 'email', 'tel', 'number', 'textarea'].includes(inputType)) {
      return {
        category: 'text-edit',
        context,
        boundary: 'text',
        coalesceKey: fieldKey(element),
      };
    }
    return { category: 'control-change', context };
  }
  if (element instanceof HTMLButtonElement) return { category: buttonCategory(element), context };
  return { category: 'control-change', context };
}
