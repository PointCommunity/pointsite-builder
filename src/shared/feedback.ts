export const feedbackScreens = {
  dashboard: { location: '/drafts', name: 'Draft list' },
  'editor.layout': { location: '/editor/layout', name: 'Editor: Layout' },
  'editor.forms': { location: '/editor/forms', name: 'Editor: Forms' },
  'editor.library': { location: '/editor/library', name: 'Editor: Library' },
  'editor.preview': { location: '/editor/preview', name: 'Editor: Preview' },
  'editor.history': { location: '/editor/history', name: 'Editor: History' },
  'editor.settings': { location: '/editor/settings', name: 'Editor: Settings' },
  'editor.admin': { location: '/editor/admin', name: 'Editor: Admin' },
} as const;

export type FeedbackScreen = keyof typeof feedbackScreens;
export type FeedbackAvailability = { mode: 'disabled' | 'pilot' | 'production' };
