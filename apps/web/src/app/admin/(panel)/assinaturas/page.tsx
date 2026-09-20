import type { Metadata } from 'next';

import { SubscriptionsView } from '@/components/platform/subscriptions-view';

export const metadata: Metadata = { title: 'Assinaturas' };

export default function Page() {
  return <SubscriptionsView />;
}
