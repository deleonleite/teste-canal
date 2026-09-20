import type { Metadata } from 'next';

import { LoginForm } from '@/components/staff/login-form';

export const metadata: Metadata = { title: 'Acesso da equipe' };

export default async function LoginPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ expirada?: string }> }) {
  const [{ tenant }, sp] = await Promise.all([params, searchParams]);
  return (
    <div className="mx-auto w-full max-w-md">
      <LoginForm tenant={tenant} expired={sp.expirada === '1'} />
    </div>
  );
}
