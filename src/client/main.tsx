import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, BuilderErrorBoundary } from './App';
import './app.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('PointSite Builder root element is missing.');
}

createRoot(root).render(
  <StrictMode>
    <div className="builder-app">
      <BuilderErrorBoundary>
        <App />
      </BuilderErrorBoundary>
    </div>
  </StrictMode>,
);
