import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Wizard } from '@/components/wizard/wizard';
import { getBranding } from '@/lib/server-api';

export async function generateMetadata() {
  const t = await getTranslations('form');
  return { title: t('title') };
}

export default async function NewComplaint({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const branding = await getBranding(tenant);
  if (!branding) notFound();
  return <Wizard tenant={tenant} allowAnonymous={branding.allowAnonymousComplaints} />;
}
