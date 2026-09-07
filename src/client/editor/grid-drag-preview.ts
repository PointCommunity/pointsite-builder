import type { SiteElement } from '../../site-kit/types';

let draggedElementType: SiteElement['type'] | null = null;

export function setDraggedElementType(type: SiteElement['type'] | null): void {
  draggedElementType = type;
}

export function getDraggedElementType(): SiteElement['type'] | null {
  return draggedElementType;
}

export function setPointerFeedbackHidden(ownerDocument: Document, hidden: boolean): void {
  const hostDocument = ownerDocument.defaultView?.frameElement?.ownerDocument ?? ownerDocument;
  hostDocument.documentElement.toggleAttribute('data-point-grid-preview', hidden);
}
