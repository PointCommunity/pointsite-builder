import { feedbackScreens, type FeedbackScreen } from '../../shared/feedback';

const key = 'pointsite-builder:feedback-return:v1';
export type FeedbackWorkspace = { screen: FeedbackScreen; draftId?: string; createdAt: number };

export function saveFeedbackWorkspace(screen: FeedbackScreen, draftId?: string) {
  sessionStorage.setItem(
    key,
    JSON.stringify({ screen, ...(draftId ? { draftId } : {}), createdAt: Date.now() }),
  );
}
export function clearFeedbackWorkspace() {
  sessionStorage.removeItem(key);
}
export function readFeedbackWorkspace(): FeedbackWorkspace | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as FeedbackWorkspace | null;
    if (
      !value ||
      !Object.hasOwn(feedbackScreens, value.screen) ||
      !Number.isFinite(value.createdAt) ||
      Date.now() - value.createdAt > 3_600_000 ||
      value.createdAt > Date.now()
    )
      return null;
    if (value.draftId !== undefined && !/^[a-f0-9-]{36}$/.test(value.draftId)) return null;
    return value;
  } catch {
    return null;
  }
}
