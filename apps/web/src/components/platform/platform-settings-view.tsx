'use client';

import { Alert, Badge, Card } from '@ouvion/ui';
import { Hammer } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { RoleGate } from './shared';

export function PlatformSettingsView() {
  const t = useTranslations('platform.settings');
  return (
    <RoleGate roles={['SUPER_ADMIN']}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-h1">{t('title')}</h1>
          <p className="text-fg-2">{t('subtitle')}</p>
        </div>
        <Alert tone="warning">{t('banner')}</Alert>
        <Card className="flex flex-col gap-3 p-4 sm:p-6">
          <h2 className="text-h3">{t('securityTitle')}</h2>
          <p data-testid="mfa-policy">{t('mfaPolicy')}</p>
        </Card>
        <Card className="flex flex-col gap-3 p-4 sm:p-6">
          <Badge tone="neutral" icon={Hammer}>
            {t('pendingLabel')}
          </Badge>
          <p className="text-fg-2">{t('pending')}</p>
        </Card>
      </div>
    </RoleGate>
  );
}
