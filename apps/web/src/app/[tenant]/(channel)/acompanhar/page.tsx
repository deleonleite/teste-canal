import { getTranslations } from 'next-intl/server';

import { TrackingView } from '@/components/tracking/tracking-view';
import { normalizeProtocol } from '@/lib/normalize';

export async function generateMetadata() {
  const t = await getTranslations('tracking');
  return { title: t('title') };
}

export default async function Track({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ protocol?: string }> }) {
  const [{ tenant }, { protocol }] = await Promise.all([params, searchParams]);
  return <TrackingView tenant={tenant} initialProtocol={protocol ? normalizeProtocol(protocol) : ''} />;
}
