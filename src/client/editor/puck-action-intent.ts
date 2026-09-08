import type { DraftActionCategory, DraftActionContext } from '../../shared/draft-actions';

export interface PuckActionIntent {
  category: DraftActionCategory;
  context: DraftActionContext;
  transient?: boolean;
}

let nextIntent: PuckActionIntent | null = null;

export function setPuckActionIntent(intent: PuckActionIntent): void {
  nextIntent = intent;
}

export function consumePuckActionIntent(): PuckActionIntent | null {
  const intent = nextIntent;
  nextIntent = null;
  return intent;
}
