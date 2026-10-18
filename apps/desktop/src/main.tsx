import './styles.css';
import { Workspace, WorkspaceProvider } from '@folio/editor';
import { createBrowserPdfEngine } from '@folio/pdf-core/browser';
import { applyInitialTheme } from '@folio/shared-ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createDesktopPlatform } from './platform';

/** Width reserved for the macOS traffic lights over the overlay title bar. */
const MACOS_TRAFFIC_LIGHTS = 78;

// Recorded so automated checks can assert the CSP blocks nothing Folio needs.
// Only the directive is kept: blocked URLs can identify documents.
const cspViolations: string[] = [];
(window as Window & { __folioCspViolations?: string[] }).__folioCspViolations = cspViolations;
window.addEventListener('securitypolicyviolation', (event) => {
  cspViolations.push(event.effectiveDirective);
});

applyInitialTheme();

const { adapter, native } = await createDesktopPlatform();
const engine = createBrowserPdfEngine();
document.documentElement.dataset.platform = native ? `desktop-${adapter.os}` : 'web';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkspaceProvider adapter={adapter} engine={engine} profile={native ? 'desktop' : 'browser'}>
      <Workspace
        chrome={{
          titleBarInset: native && adapter.os === 'macos' ? MACOS_TRAFFIC_LIGHTS : 0,
          dragRegion: native,
          brand: !native,
        }}
      />
    </WorkspaceProvider>
  </StrictMode>,
);
