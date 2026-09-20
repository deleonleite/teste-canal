'use client';

import { createContext, useContext, type ReactNode } from 'react';

import type { Branding } from '@/lib/branding-type';

const Ctx = createContext<Branding | null>(null);

export function BrandingProvider({ branding, children }: { branding: Branding; children: ReactNode }) {
  return <Ctx.Provider value={branding}>{children}</Ctx.Provider>;
}

export function useBranding(): Branding {
  const b = useContext(Ctx);
  if (!b) throw new Error('useBranding fora do BrandingProvider');
  return b;
}
