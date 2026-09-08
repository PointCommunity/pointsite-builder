import { afterEach, describe, expect, it } from 'vitest';
import { mutationForContext } from '../../src/client/editor/action-attribution';

afterEach(() => {
  document.body.replaceChildren();
});

describe('draft action attribution', () => {
  it('coalesces a focused text control with an opaque local-only key', () => {
    const input = document.createElement('input');
    input.value = 'private content';
    input.setAttribute('aria-label', 'Mission statement');
    document.body.appendChild(input);
    input.focus();

    const mutation = mutationForContext('site-settings');
    expect(mutation).toMatchObject({
      category: 'text-edit',
      context: 'site-settings',
      boundary: 'text',
    });
    expect(mutation.coalesceKey).toMatch(/^field-\d+$/);
    expect(JSON.stringify(mutation)).not.toContain('private content');
    expect(JSON.stringify(mutation)).not.toContain('Mission statement');
  });

  it.each([
    ['Add social link', 'add'],
    ['Duplicate section', 'duplicate'],
    ['Move section down', 'reorder'],
    ['Remove section', 'remove'],
    ['Undo', 'undo'],
    ['Redo', 'redo'],
  ] as const)('maps the stable control verb %s to %s', (label, category) => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', label);
    document.body.appendChild(button);
    button.focus();
    expect(mutationForContext('page-structure')).toEqual({
      category,
      context: 'page-structure',
    });
  });
});
