import { render, screen } from '@testing-library/react';
import { App } from '../../src/client/App';

describe('PointSite Builder foundation', () => {
  it('identifies the private authoring surface and production lock', () => {
    render(<App />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Build PointSite safely.' }),
    ).toBeVisible();
    expect(screen.getByText('Private authoring')).toBeVisible();
    expect(screen.getByText(/production lock/i)).toBeVisible();
  });
});
