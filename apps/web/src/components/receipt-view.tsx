'use client';

import { Alert, Button, Card, Checkbox, Mono } from '@ouvion/ui';
import { Copy, Printer } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { api, type LookupResponse } from '@/lib/api-client';
import { useReceipt, useTracking } from '@/lib/stores';

/**
 * Tela de confirmação (§8.3). A chave de acesso existe SÓ na memória desta aba: é exibida uma vez, não vai
 * para a URL nem para o armazenamento, e é apagada ao continuar. "Continuar" só habilita com o checkbox
 * marcado — é a única rede de segurança de quem escolheu o anonimato total.
 */
export function ReceiptView({ tenant, protocolParam }: { tenant: string; protocolParam: string | null }) {
  const t = useTranslations('receipt');
  const tc = useTranslations('common');
  const tf = useTranslations('form');
  const router = useRouter();
  const receipt = useReceipt();
  const setTracking = useTracking((s) => s.set);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const hasKey = Boolean(receipt.accessKey && receipt.protocol && (!protocolParam || protocolParam === receipt.protocol));

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(tc('copied'));
    } catch {
      /* clipboard bloqueado: o texto continua selecionável na tela */
    }
  };

  const proceed = async () => {
    setBusy(true);
    try {
      // Abre a sessão de acompanhamento com a chave que ainda está na memória; depois a chave é apagada.
      const data = await api(tenant).post<LookupResponse>('public/complaints/lookup', { protocol: receipt.protocol, accessKey: receipt.accessKey });
      setTracking(data);
    } catch {
      /* sem sessão: a tela de acompanhamento pedirá protocolo e chave */
    }
    receipt.wipeKey();
    router.push(`/${tenant}/acompanhar`);
  };

  if (!hasKey) {
    return (
      <Card className="mx-auto flex max-w-2xl flex-col gap-4">
        <h1>{t('keyGoneTitle')}</h1>
        <p className="text-fg-2">{t('keyGoneBody')}</p>
        <Button className="self-start" onClick={() => router.push(`/${tenant}/acompanhar${protocolParam ? `?protocol=${encodeURIComponent(protocolParam)}` : ''}`)}>
          {t('goTrack')}
        </Button>
      </Card>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-display">{t('title')}</h1>
        <p className="max-w-prose text-fg-2">{t('body')}</p>
      </div>

      {receipt.uploadFailures > 0 && (
        <Alert tone="warning">
          <p>{tf('uploadPartial', { count: receipt.uploadFailures })}</p>
        </Alert>
      )}

      <Card className="print-area flex flex-col gap-6">
        <h2 className="sr-only print:not-sr-only">{t('printTitle')}</h2>
        <div className="flex flex-col gap-2">
          <p className="text-body-sm font-medium text-fg-2">{t('protocol')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Mono className="select-all text-h1" data-testid="receipt-protocol">
              {receipt.protocol}
            </Mono>
            <Button variant="secondary" onClick={() => copy(receipt.protocol!)} className="no-print" aria-label={t('copyProtocol')}>
              <Copy className="h-4 w-4" aria-hidden="true" />
              {tc('copy')}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-body-sm font-medium text-fg-2">{t('key')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Mono className="select-all break-all text-h1" data-testid="receipt-key">
              {receipt.accessKey}
            </Mono>
            <Button variant="secondary" onClick={() => copy(receipt.accessKey!)} className="no-print" aria-label={t('copyKey')}>
              <Copy className="h-4 w-4" aria-hidden="true" />
              {tc('copy')}
            </Button>
          </div>
        </div>
        <p className="text-body-sm text-fg-2">{t('lostKeyWarning')}</p>
        <div className="no-print">
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden="true" />
            {tc('print')}
          </Button>
        </div>
      </Card>

      <div className="no-print flex flex-col gap-4">
        <Checkbox checked={ack} onCheckedChange={(c) => setAck(c === true)} label={t('ack')} />
        <Button size="lg" className="self-start" disabled={!ack} loading={busy} onClick={proceed}>
          {t('continue')}
        </Button>
      </div>
    </div>
  );
}
