import type { Metadata } from 'next';

import { PlatformSettingsView } from '@/components/platform/platform-settings-view';

export const metadata: Metadata = { title: 'Configurações globais' };

export default function Page() {
  return <PlatformSettingsView />;
}
