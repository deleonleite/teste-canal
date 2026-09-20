import type { Metadata } from 'next';

import { BreakGlassView } from '@/components/platform/break-glass-view';

export const metadata: Metadata = { title: 'Quebra de vidro' };

export default function Page() {
  return <BreakGlassView />;
}
