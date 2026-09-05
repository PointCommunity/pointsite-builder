export function App() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="app-header">
        <div>
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span>PointSite Builder</span>
        </div>
        <span className="environment-label">Local foundation</span>
      </header>
      <main id="main-content" className="foundation-panel">
        <p className="eyebrow">Private authoring</p>
        <h1>Build PointSite safely.</h1>
        <p>
          The controlled editor, drafts, staging preview, and publishing workflow are being
          assembled behind the production lock.
        </p>
      </main>
    </div>
  );
}
