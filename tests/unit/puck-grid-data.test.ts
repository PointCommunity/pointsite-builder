import type { Data } from '@puckeditor/core';
import {
  childComponents,
  documentComponentId,
  siblingComponents,
} from '../../src/client/editor/puck-grid-data';

const data: Data = {
  root: { props: {} },
  content: [
    {
      type: 'Section',
      props: {
        id: 'section-1',
        content: [
          { type: 'heading', props: { id: 'heading-1', grid: { desktop: {} } } },
          { type: 'button', props: { id: 'button-1', grid: { desktop: {} } } },
        ],
      },
    },
  ],
};

describe('Puck grid data traversal', () => {
  it('keeps document UUIDs stable across inserted, duplicated and reopened components', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    for (const type of ['Section', 'ThreeColumnSection', 'richText', 'socialLinks']) {
      expect(documentComponentId({ type, props: { id: `${type}-${id}` } })).toBe(id);
      expect(documentComponentId({ type, props: { id } })).toBe(id);
    }
  });

  it('finds direct children for insertion collision checks', () => {
    expect(childComponents(data, 'section-1').map((item) => item.props.id)).toEqual([
      'heading-1',
      'button-1',
    ]);
  });

  it('keeps the placement UUID when an inserted component changes type', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    for (const originalType of ['hero', 'heading', 'splitFeature', 'cards', 'people', 'form'])
      expect(
        documentComponentId({ type: 'composition', props: { id: `${originalType}-${id}` } }),
      ).toBe(id);
    expect(documentComponentId({ type: 'composition', props: { id: 'unknown-not-a-uuid' } })).toBe(
      'unknown-not-a-uuid',
    );
  });

  it('finds live siblings for movement and inspector collision checks', () => {
    expect(siblingComponents(data, 'button-1').map((item) => item.props.id)).toEqual([
      'heading-1',
      'button-1',
    ]);
  });
});
