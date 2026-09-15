import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { renderBlock } from '../../src/site-kit/registry';
import { themeToTokens } from '../../src/site-kit/tokens';
import { SiteElementSchema } from '../../src/site-kit/schema';
import type { SiteDocument } from '../../src/site-kit/types';
import '../../src/site-kit/site.css';

const host = document.createElement('main');
document.body.replaceChildren(host);
const root = createRoot(host);

export function show(block: unknown, site: SiteDocument) {
  flushSync(() =>
    root.render(
      <div className="point-site" style={themeToTokens(site.theme)}>
        {renderBlock(SiteElementSchema.parse(block), site)}
      </div>,
    ),
  );
}
