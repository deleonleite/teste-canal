import type { Metadata } from 'next';

import { CaseListView } from '@/components/staff/case-list';

export const metadata: Metadata = { title: 'Casos' };

export default async function CasesPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <CaseListView tenant={tenant} />;
}
