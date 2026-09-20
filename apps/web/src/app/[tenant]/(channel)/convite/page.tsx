import type { Metadata } from 'next';

import { InviteAccept } from '@/components/onboarding/invite-accept';

// O token do convite vem na URL: nunca deixar o navegador mandá-lo adiante em Referer (já é no-referrer) nem indexar.
export const metadata: Metadata = { title: 'Convite', referrer: 'no-referrer' };

export default async function Page({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ token?: string }> }) {
  const [{ tenant }, sp] = await Promise.all([params, searchParams]);
  return (
    <div className="mx-auto w-full max-w-md">
      <InviteAccept tenant={tenant} token={sp.token ?? null} />
    </div>
  );
}
