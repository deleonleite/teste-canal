import type { Metadata } from 'next';

import { RecipientConfirm } from '@/components/onboarding/recipient-confirm';

export const metadata: Metadata = { title: 'Destinatário alternativo', referrer: 'no-referrer' };

export default async function Page({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ token?: string }> }) {
  const [{ tenant }, sp] = await Promise.all([params, searchParams]);
  return (
    <div className="mx-auto w-full max-w-md">
      <RecipientConfirm tenant={tenant} token={sp.token ?? null} />
    </div>
  );
}
