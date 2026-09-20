'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

export function Providers({ children }: { children: ReactNode }) {
  // Nada de dado de denúncia fica em cache persistente: o cache do TanStack vive só na memória da aba e é
  // descartado logo (gcTime 0) — mensagens e casos nunca "sobram" para uma próxima tela.
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: false } } }));
  return (
    <QueryClientProvider client={client}>
      {children}
      {/* Toast sem estilo próprio da biblioteca: usa os tokens do design system (contraste nos dois temas). */}
      <Toaster
        position="top-center"
        toastOptions={{
          unstyled: true,
          classNames: {
            toast: 'flex w-[min(92vw,26rem)] items-start gap-3 rounded-md border border-line-strong bg-surface p-4 font-sans text-body text-fg shadow-modal',
            title: 'font-medium text-fg',
            description: 'text-body-sm text-fg-2',
            icon: 'mt-0.5',
            success: 'border-success',
            error: 'border-danger',
          },
        }}
      />
    </QueryClientProvider>
  );
}
