import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api/client';
import { startOutbox } from './offline';
import { router } from './router';
import { LanguageProvider } from './i18n/i18n';
import { SessionProvider } from './session/session';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Client errors (4xx) won't fix themselves; only retry network and server errors.
      retry: (count, err) =>
        count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      refetchOnWindowFocus: true,
    },
  },
});

// The phone and browser app open with no signal and send what waited once it returns. The desktop app serves its
// own files and keeps no service worker.
startOutbox();
if ('serviceWorker' in navigator && location.protocol !== 'app:' && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <LanguageProvider>
          <RouterProvider router={router} />
        </LanguageProvider>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
