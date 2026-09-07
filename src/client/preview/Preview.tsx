import {
  DeviceMobile,
  DeviceTablet,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Monitor,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { SiteDocument } from '../../site-kit/types';
import { SitePreviewFrame } from './SitePreviewFrame';

const widths = { phone: 360, tablet: 768, desktop: 1280 } as const;
const zoomSteps = [25, 50, 75, 100, 125] as const;
type Zoom = 'auto' | number;

const viewportIcons = {
  phone: DeviceMobile,
  tablet: DeviceTablet,
  desktop: Monitor,
};

export function Preview({ document }: { document: SiteDocument }) {
  const [viewport, setViewport] = useState<keyof typeof widths>('desktop');
  const [zoom, setZoom] = useState<Zoom>('auto');
  const [stageWidth, setStageWidth] = useState(0);
  const [pageId, setPageId] = useState(document.pages[0]?.id ?? '');
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry?.contentRect.width ?? 0));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  const page = document.pages.find((candidate) => candidate.id === pageId) ?? document.pages[0];
  if (!page) return <p>No page selected.</p>;
  const width = widths[viewport];
  const autoPercent = Math.max(25, Math.min(100, Math.floor(((stageWidth - 32) / width) * 100)));
  const zoomPercent = zoom === 'auto' ? autoPercent : zoom;
  const scale = zoomPercent / 100;
  const stepZoom = (direction: -1 | 1) => {
    const current = zoom === 'auto' ? autoPercent : zoom;
    const next =
      direction < 0
        ? [...zoomSteps].reverse().find((value) => value < current)
        : zoomSteps.find((value) => value > current);
    if (next) setZoom(next);
  };
  const navigate = (route: string) => {
    const target = document.pages.find((candidate) => candidate.route === route);
    if (target) setPageId(target.id);
  };
  return (
    <section className="preview-panel" aria-labelledby="preview-title">
      <div className="preview-toolbar">
        <div className="preview-toolbar__identity">
          <span className="live-indicator" aria-hidden="true" />
          <h2 id="preview-title">Live preview</h2>
        </div>
        <label className="preview-toolbar__page">
          <span>Page</span>
          <select value={page.id} onChange={(event) => setPageId(event.target.value)}>
            {document.pages.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <div className="preview-controls" aria-label="Preview controls">
          <div className="preview-control-group" aria-label="Preview viewport">
            {(Object.keys(widths) as Array<keyof typeof widths>).map((name) => {
              const Icon = viewportIcons[name];
              return (
                <button
                  type="button"
                  key={name}
                  aria-label={`Preview at ${name} width`}
                  aria-pressed={viewport === name}
                  onClick={() => setViewport(name)}
                >
                  <Icon size={18} aria-hidden="true" />
                </button>
              );
            })}
          </div>
          <span className="preview-control-divider" aria-hidden="true" />
          <div className="preview-control-group" aria-label="Zoom settings">
            <button
              type="button"
              aria-label="Zoom preview out"
              disabled={zoomPercent <= zoomSteps[0]}
              onClick={() => stepZoom(-1)}
            >
              <MagnifyingGlassMinus size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Zoom preview in"
              disabled={zoomPercent >= zoomSteps[zoomSteps.length - 1]}
              onClick={() => stepZoom(1)}
            >
              <MagnifyingGlassPlus size={18} aria-hidden="true" />
            </button>
            <select
              aria-label="Preview zoom"
              value={zoom}
              onChange={(event) =>
                setZoom(event.target.value === 'auto' ? 'auto' : Number(event.target.value))
              }
            >
              <option value="auto">{autoPercent}% (Auto)</option>
              {zoomSteps.map((value) => (
                <option value={value} key={value}>
                  {value}%
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div
        ref={stageRef}
        className="preview-stage"
        tabIndex={0}
        aria-label="Scrollable preview viewport"
      >
        <SitePreviewFrame
          document={document}
          route={page.route}
          width={width}
          scale={scale}
          onNavigate={navigate}
        />
      </div>
    </section>
  );
}
