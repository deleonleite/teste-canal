import type { Metadata } from 'next';

import { BreakGlassDetail } from '@/components/platform/break-glass-detail';

export const metadata: Metadata = { title: 'Acesso excepcional' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BreakGlassDetail id={id} />;
}
