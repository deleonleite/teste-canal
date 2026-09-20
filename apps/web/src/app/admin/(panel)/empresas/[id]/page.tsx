import type { Metadata } from 'next';

import { TenantDetailView } from '@/components/platform/tenant-detail-view';

export const metadata: Metadata = { title: 'Empresa' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TenantDetailView id={id} />;
}
