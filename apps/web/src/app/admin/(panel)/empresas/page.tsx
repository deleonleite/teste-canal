import type { Metadata } from 'next';

import { TenantsView } from '@/components/platform/tenants-view';

export const metadata: Metadata = { title: 'Empresas' };

export default function Page() {
  return <TenantsView />;
}
