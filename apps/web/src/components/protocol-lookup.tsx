'use client';

import { Button, Input } from '@ouvion/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type ClipboardEvent, type FormEvent } from 'react';

import { normalizeProtocol } from '@/lib/normalize';

/** Caixa "já fez um relato?": só o protocolo vai na URL; a chave nunca passa por ela. */
export function ProtocolLookup({ tenant }: { tenant: string }) {
  const t = useTranslations('landing');
  const router = useRouter();
  const [value, setValue] = useState('');

  const go = (e: FormEvent) => {
    e.preventDefault();
    const p = normalizeProtocol(value);
    router.push(`/${tenant}/acompanhar${p ? `?protocol=${encodeURIComponent(p)}` : ''}`);
  };
  // Colar com espaços, hífens ou quebras de linha: normaliza antes de qualquer validação.
  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    setValue(normalizeProtocol(e.clipboardData.getData('text')));
  };

  return (
    <form onSubmit={go} className="flex flex-col gap-3 sm:flex-row" role="search" aria-label={t('trackTitle')}>
      <label className="sr-only" htmlFor="landing-protocol">
        {t('trackTitle')}
      </label>
      <Input
        id="landing-protocol"
        value={value}
        onChange={(e) => setValue(normalizeProtocol(e.target.value))}
        onPaste={paste}
        placeholder={t('trackPlaceholder')}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        className="font-mono uppercase tracking-wide"
      />
      <Button type="submit" variant="secondary">
        {t('trackCta')}
      </Button>
    </form>
  );
}
