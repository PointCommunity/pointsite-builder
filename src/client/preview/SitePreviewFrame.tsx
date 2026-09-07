import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import siteCss from '../../site-kit/site.css?inline';
import { SiteRenderer } from '../../site-kit/SiteRenderer';
import type { SiteDocument } from '../../site-kit/types';

const previewShell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${siteCss}</style>
  </head>
  <body><div id="site-preview-root"></div></body>
</html>`;

export function SitePreviewFrame({
  document,
  route,
  width,
  scale,
  onNavigate,
}: {
  document: SiteDocument;
  route: string;
  width: number;
  scale: number;
  onNavigate: (route: string) => void;
}) {
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
  const connectFrame = useCallback((frame: HTMLIFrameElement) => {
    setMountNode(frame.contentDocument?.getElementById('site-preview-root') ?? null);
  }, []);

  return (
    <div
      className="preview-frame-viewport"
      style={{ width: width * scale }}
      data-preview-scale={scale}
    >
      <iframe
        className="preview-frame"
        title={`Live preview of ${route} at ${width} pixels`}
        srcDoc={previewShell}
        style={{ width, height: `${100 / scale}%`, transform: `scale(${scale})` }}
        onLoad={(event) => connectFrame(event.currentTarget)}
      />
      {mountNode
        ? createPortal(
            <SiteRenderer document={document} route={route} onNavigate={onNavigate} />,
            mountNode,
          )
        : null}
    </div>
  );
}
