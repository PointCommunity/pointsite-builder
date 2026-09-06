import { useCallback, useEffect, useState } from 'react';
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
  onNavigate,
}: {
  document: SiteDocument;
  route: string;
  width: number;
  onNavigate: (route: string) => void;
}) {
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
  const connectFrame = useCallback((frame: HTMLIFrameElement) => {
    setMountNode(frame.contentDocument?.getElementById('site-preview-root') ?? null);
  }, []);

  useEffect(() => {
    if (!mountNode) return;
    const navigate = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
      if (!anchor) return;
      const url = new URL(anchor.href);
      const target = document.pages.find((page) => page.route === url.pathname);
      if (!target || url.origin !== globalThis.location.origin) return;
      event.preventDefault();
      onNavigate(target.route);
    };
    const frameDocument = mountNode.ownerDocument;
    frameDocument.addEventListener('click', navigate);
    return () => frameDocument.removeEventListener('click', navigate);
  }, [document.pages, mountNode, onNavigate]);

  return (
    <>
      <iframe
        className="preview-frame"
        title={`Live preview of ${route} at ${width} pixels`}
        srcDoc={previewShell}
        style={{ width }}
        onLoad={(event) => connectFrame(event.currentTarget)}
      />
      {mountNode
        ? createPortal(<SiteRenderer document={document} route={route} />, mountNode)
        : null}
    </>
  );
}
