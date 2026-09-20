import type { Metadata } from 'next';

import { ActivationView } from '@/components/staff/activation-view';

export const metadata: Metadata = { title: 'Ativação da empresa' };

export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <ActivationView tenant={tenant} />;
}
