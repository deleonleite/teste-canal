import type { Metadata } from 'next';

import { ConflictsView } from '@/components/staff/conflicts-view';

export const metadata: Metadata = { title: 'Conflitos' };

export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <ConflictsView tenant={tenant} />;
}
