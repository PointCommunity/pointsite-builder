import type { Data } from '@puckeditor/core';
import { childComponents, siblingComponents } from '../../src/client/editor/puck-grid-data';

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
  it('finds direct children for insertion collision checks', () => {
    expect(childComponents(data, 'section-1').map((item) => item.props.id)).toEqual([
      'heading-1',
      'button-1',
    ]);
  });

  it('finds live siblings for movement and inspector collision checks', () => {
    expect(siblingComponents(data, 'button-1').map((item) => item.props.id)).toEqual([
      'heading-1',
      'button-1',
    ]);
  });
});
