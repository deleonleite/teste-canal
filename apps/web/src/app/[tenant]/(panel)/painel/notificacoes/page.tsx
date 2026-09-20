import type { Metadata } from 'next';

import { NotificationsView } from '@/components/staff/notifications-view';

export const metadata: Metadata = { title: 'Notificações' };

export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <NotificationsView tenant={tenant} />;
}
