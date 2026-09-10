import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeedbackButton } from '../../src/client/feedback/FeedbackButton';
import { api } from '../../src/client/api';

describe('feedback control', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });
  it('stays absent when disabled', async () => {
    vi.spyOn(api, 'feedbackAvailability').mockResolvedValue({ mode: 'disabled' });
    render(<FeedbackButton screen="dashboard" />);
    await waitFor(() => expect(api.feedbackAvailability).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('preserves the workspace before launch and reports failures without navigating', async () => {
    vi.spyOn(api, 'feedbackAvailability').mockResolvedValue({ mode: 'pilot' });
    const launch = vi
      .spyOn(api, 'launchFeedback')
      .mockRejectedValue(new Error('private server detail'));
    const prepare = vi.fn().mockResolvedValue(undefined);
    render(<FeedbackButton screen="editor.settings" beforeLaunch={prepare} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback (test)' }));
    await screen.findByRole('alert');
    expect(prepare).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith('editor.settings');
    expect(screen.getByRole('alert')).toHaveTextContent('Your draft is safe');
    expect(screen.queryByText('private server detail')).not.toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });
  it('does not launch if workspace preparation fails', async () => {
    vi.spyOn(api, 'feedbackAvailability').mockResolvedValue({ mode: 'production' });
    const launch = vi.spyOn(api, 'launchFeedback');
    render(
      <FeedbackButton
        screen="editor.layout"
        beforeLaunch={() => Promise.reject(new Error('pending'))}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    await screen.findByRole('alert');
    expect(launch).not.toHaveBeenCalled();
  });
});
