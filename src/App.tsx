import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { FlowCanvas } from './components/canvas/FlowCanvas';
import { initializeDatabase } from './data/lookup';
import { LoadingScreen } from './components/shared/LoadingScreen';
import { ConfirmDialog } from './components/shared/ConfirmDialog';
import { PwaManager } from './pwa/PwaManager';
import { NotFoundPage } from './components/shared/NotFoundPage';
import { SimpleMode } from './simple/SimpleMode';

type UiMode = 'simple' | 'graph';
const MODE_STORAGE_KEY = 'industrialist-ui-mode';

function readInitialMode(): UiMode {
  // A shared simple-mode link always opens simple mode.
  if (window.location.hash.startsWith('#s=')) return 'simple';
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'graph' ? 'graph' : 'simple';
  } catch {
    return 'simple';
  }
}

function isAppPath(pathname: string) {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  return normalizedPath === '/' || normalizedPath === '/index.html';
}

export function App() {
  const [isDatabaseLoaded, setIsDatabaseLoaded] = useState(false);
  const [, setThrowError] = useState<unknown>();
  const isNotFound = !isAppPath(window.location.pathname);
  const [mode, setMode] = useState<UiMode>(readInitialMode);

  const switchMode = (next: UiMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Not critical: the mode just won't be remembered.
    }
  };

  useEffect(() => {
    if (isNotFound) return;

    initializeDatabase()
      .then(() => {
        setIsDatabaseLoaded(true);
      })
      .catch((err) => {
        console.error('Failed to initialize database:', err);
        setThrowError(() => {
          throw err;
        });
      });
  }, [isNotFound]);

  return (
    <>
      <PwaManager />
      {isNotFound ? (
        <NotFoundPage />
      ) : !isDatabaseLoaded ? (
        <LoadingScreen title="Starting Industrialist Calculator" subtitle="Loading recipe data…" />
      ) : mode === 'simple' ? (
        <SimpleMode onOpenGraph={() => switchMode('graph')} />
      ) : (
        <ReactFlowProvider>
          <FlowCanvas />
          <ConfirmDialog />
          <button
            className="simple-button simple-mode-toggle"
            type="button"
            onClick={() => switchMode('simple')}
          >
            ← Простой режим
          </button>
        </ReactFlowProvider>
      )}
    </>
  );
}
