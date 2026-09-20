import type { Metadata } from 'next';

import { PlatformAuditView } from '@/components/platform/platform-audit-view';

export const metadata: Metadata = { title: 'Auditoria da plataforma' };

export default function Page() {
  return <PlatformAuditView />;
}
