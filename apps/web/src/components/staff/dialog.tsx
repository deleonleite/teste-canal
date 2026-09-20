'use client';

import { Button } from '@ouvion/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Janela de confirmação sobre o <dialog> nativo: o navegador já prende o foco dentro dela, fecha com Esc e
 * devolve o foco ao botão que a abriu. Usada só para ações irreversíveis ou sensíveis.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  confirmDisabled,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('common');
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-[min(92vw,32rem)] rounded-lg border border-line-strong bg-surface p-0 text-fg shadow-modal backdrop:bg-black/50"
    >
      {open && (
        <div className="flex flex-col gap-4 p-6">
          <h2 id={titleId} className="text-h2">
            {title}
          </h2>
          <div className="flex flex-col gap-4">{children}</div>
          <div className="flex flex-wrap justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} disabled={confirmDisabled} data-testid="dialog-confirm">
              {confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
