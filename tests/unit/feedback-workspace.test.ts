import {
  clearFeedbackWorkspace,
  readFeedbackWorkspace,
  saveFeedbackWorkspace,
} from '../../src/client/feedback/workspace';

describe('feedback workspace marker', () => {
  afterEach(() => sessionStorage.clear());
  it('preserves only local restoration context and expires stale markers', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    saveFeedbackWorkspace('editor.preview', '10000000-0000-4000-8000-000000000001');
    expect(readFeedbackWorkspace()).toEqual({
      screen: 'editor.preview',
      draftId: '10000000-0000-4000-8000-000000000001',
      createdAt: now,
    });
    vi.mocked(Date.now).mockReturnValue(now + 3_600_001);
    expect(readFeedbackWorkspace()).toBeNull();
    vi.restoreAllMocks();
    clearFeedbackWorkspace();
    expect(sessionStorage.length).toBe(0);
  });
  it('rejects malformed storage safely', () => {
    sessionStorage.setItem('pointsite-builder:feedback-return:v1', '{bad');
    expect(readFeedbackWorkspace()).toBeNull();
  });
});
