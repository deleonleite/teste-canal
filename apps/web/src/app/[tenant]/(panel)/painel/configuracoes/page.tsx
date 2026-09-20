import type { Metadata } from 'next';

import { SettingsView } from '@/components/staff/settings-view';

export const metadata: Metadata = { title: 'Configurações' };

export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <SettingsView tenant={tenant} />;
}
