import type { Metadata } from 'next';

import { UsersView } from '@/components/staff/users-view';

export const metadata: Metadata = { title: 'Equipe' };

export default async function UsersPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <UsersView tenant={tenant} />;
}
