import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MediaLibrary, type MediaClient } from '../../src/client/media/MediaLibrary';

it('loads an accessible empty library and uploads with required alt text', async () => {
  const upload = vi.fn(() =>
    Promise.resolve({
      id: '1',
      filename: 'point.png',
      contentType: 'image/png',
      byteSize: 24,
      width: 100,
      height: 80,
      altText: 'Point gathering',
      status: 'ready',
      createdAt: '2026-09-05T00:00:00Z',
    }),
  );
  const client: MediaClient = {
    list: () => Promise.resolve([]),
    upload,
  };
  render(<MediaLibrary client={client} />);
  expect(await screen.findByText('No uploaded media yet')).toBeVisible();
  const file = new File([new Uint8Array([1])], 'point.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Image file'), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText('Alternative text'), {
    target: { value: 'Point gathering' },
  });
  const form = screen.getByRole('button', { name: 'Upload image' }).closest('form');
  if (!form) throw new Error('Upload form is missing');
  fireEvent.submit(form);
  await waitFor(() => expect(upload).toHaveBeenCalledWith(file, 'Point gathering'));
  expect(await screen.findByText('point.png')).toBeVisible();
});
