import type { Metadata } from 'next';

import { InternalUsersView } from '@/components/platform/internal-users-view';

export const metadata: Metadata = { title: 'Usuários internos' };

export default function Page() {
  return <InternalUsersView />;
}
