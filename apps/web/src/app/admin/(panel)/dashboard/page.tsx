import type { Metadata } from 'next';

import { PlatformDashboard } from '@/components/platform/platform-dashboard';

export const metadata: Metadata = { title: 'Dashboard' };

export default function Page() {
  return <PlatformDashboard />;
}
