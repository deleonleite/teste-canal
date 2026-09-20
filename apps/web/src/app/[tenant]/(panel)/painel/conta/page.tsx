import type { Metadata } from 'next';

import { AccountView } from '@/components/staff/account-view';

export const metadata: Metadata = { title: 'Minha conta' };

export default async function AccountPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <AccountView tenant={tenant} />;
}
