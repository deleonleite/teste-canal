import type { Metadata } from 'next';

import { CaseDetailView } from '@/components/staff/case-detail';

export const metadata: Metadata = { title: 'Caso' };

export default async function CasePage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  return <CaseDetailView tenant={tenant} id={id} />;
}
