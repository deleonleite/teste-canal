import type { Metadata } from 'next';

import { AuditView } from '@/components/staff/audit-view';

export const metadata: Metadata = { title: 'Auditoria' };

export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <AuditView tenant={tenant} />;
}
