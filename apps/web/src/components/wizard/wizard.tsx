'use client';

import { Alert, Button, Stepper } from '@ouvion/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { toast } from 'sonner';

import { api, classifyError, type CreateResponse } from '@/lib/api-client';
import { clearPersistedDraft, loadPersistedDraft, persistDraft, useDraft, useReceipt } from '@/lib/stores';
import {
  BLUR_FIELDS,
  buildPayload,
  checkFile,
  MAX_FILES,
  STEP_FIELDS,
  validateComplaint,
  type ComplaintFormValues,
  type FieldErrors,
} from '@/lib/validation';
import { StepAnonymity, StepAttachments, StepFacts, StepInvolved, StepReview } from './steps';

interface Props {
  tenant: string;
  allowAnonymous: boolean;
}

export function Wizard({ tenant, allowAnonymous }: Props) {
  const t = useTranslations('form');
  const tv = useTranslations('validation');
  const te = useTranslations('errors');
  const tc = useTranslations('common');
  const router = useRouter();

  const draft = useDraft();
  const setReceipt = useReceipt((s) => s.setReceipt);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fileWarnings, setFileWarnings] = useState<string[]>([]);
  const [restorable, setRestorable] = useState<ComplaintFormValues | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const steps = t.raw('steps') as string[];

  // As regras vêm do schema da API; os textos, do dicionário i18n.
  const resolver = useMemo<Resolver<ComplaintFormValues>>(
    () => async (values) => {
      const errors = validateComplaint(values, (k) => tv(k));
      const rhf: Record<string, { type: string; message: string }> = {};
      for (const [k, message] of Object.entries(errors)) rhf[k] = { type: 'validate', message: message as string };
      return Object.keys(rhf).length ? { values: {}, errors: rhf as never } : { values, errors: {} };
    },
    [tv],
  );

  const form = useForm<ComplaintFormValues>({ defaultValues: draft.values, resolver, mode: 'onSubmit', reValidateMode: 'onSubmit' });
  const { getValues, trigger, watch, formState, setFocus } = form;
  const errors = formState.errors as Partial<Record<keyof ComplaintFormValues, { message?: string }>>;
  const fieldErrors: FieldErrors = Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v?.message]));

  // Espelha o formulário no estado em memória (e, só com opt-in, no armazenamento local por até 24 h).
  useEffect(() => {
    const sub = watch((values) => draft.setValues(values as ComplaintFormValues));
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch]);
  useEffect(() => {
    if (!draft.persist) return;
    const id = setTimeout(() => persistDraft(tenant, draft.values), 400);
    return () => clearTimeout(id);
  }, [draft.persist, draft.values, tenant]);

  // Rascunho salvo em sessão anterior (opt-in): oferecido, nunca aplicado em silêncio.
  useEffect(() => {
    if (draft.values.title || draft.values.description) return;
    setRestorable(loadPersistedDraft(tenant));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);

  // Aviso ao fechar a aba com relato em andamento e sem rascunho salvo.
  const hasContent = Boolean(draft.values.title || draft.values.description || draft.values.involvedPeople || draft.files.length);
  useEffect(() => {
    if (!hasContent || draft.persist) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [hasContent, draft.persist]);

  // Foco no título da etapa ao trocar (leitor de tela e teclado acompanham a mudança).
  useEffect(() => {
    headingRef.current?.focus();
  }, [draft.step]);

  const goTo = useCallback((s: number) => draft.setStep(Math.max(0, Math.min(4, s))), [draft]);

  const next = async () => {
    setSubmitError(null);
    const fields = STEP_FIELDS[draft.step] ?? [];
    if (fields.length && !(await trigger(fields))) {
      const first = fields.find((f) => (errors as Record<string, unknown>)[f]);
      if (first) setFocus(first);
      return;
    }
    goTo(draft.step + 1);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const warnings: string[] = [];
    const accepted = [...draft.files];
    for (const f of Array.from(list)) {
      const verdict = checkFile(f, { anonymous: true });
      if (verdict === 'bad_type') warnings.push(t('step3.badType', { name: f.name }));
      else if (verdict === 'doc_anonymous') warnings.push(t('step3.docAnonymous', { name: f.name }));
      else if (verdict === 'too_big') warnings.push(t('step3.tooBig', { name: f.name }));
      else if (accepted.length >= MAX_FILES) warnings.push(t('step3.tooMany'));
      else accepted.push(f);
    }
    draft.setFiles(accepted);
    setFileWarnings([...new Set(warnings)]);
  };

  const submit = async () => {
    setSubmitError(null);
    const values = getValues();
    const found = validateComplaint(values, (k) => tv(k));
    if (Object.keys(found).length) {
      await trigger();
      const badStep = STEP_FIELDS.findIndex((fs) => fs.some((f) => found[f]));
      if (badStep >= 0) goTo(badStep);
      return;
    }
    setSubmitting(true);
    try {
      const client = api(tenant);
      const res = await client.post<CreateResponse>('public/complaints', buildPayload(values));
      // Envia os anexos com o token de sessão do protocolo. Falha no upload NÃO desfaz o relato.
      let failures = 0;
      for (const file of draft.files) {
        try {
          await client.upload('public/channel/attachments', file, res.sessionToken);
        } catch {
          failures++;
        }
      }
      setReceipt({ protocol: res.protocol, accessKey: res.accessKey, sessionToken: res.sessionToken, uploadFailures: failures });
      clearPersistedDraft(tenant);
      draft.reset();
      router.push(`/${tenant}/denuncia-confirmada?protocol=${encodeURIComponent(res.protocol)}`);
    } catch (e) {
      const kind = classifyError(e);
      setSubmitError(kind === 'too_many' ? te('tooMany') : kind === 'network' ? te('offline') : kind === 'bad_request' ? te('generic') : te('generic'));
      toast.error(kind === 'too_many' ? te('tooMany') : te('generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const exit = () => {
    clearPersistedDraft(tenant);
    draft.reset();
    router.push(`/${tenant}`);
  };

  const step = draft.step;
  const last = step === 4;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 pb-32">
      <Stepper steps={steps} current={step} label={t('progress')} srDone={t('stepDone')} srCurrent={t('stepCurrent')} />

      {restorable && (
        <Alert tone="info" title={t('restoreTitle')}>
          <p>{t('restoreBody')}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button
              variant="primary"
              onClick={() => {
                form.reset(restorable);
                draft.hydrate(restorable);
                draft.setPersist(true);
                setRestorable(null);
              }}
            >
              {t('restoreYes')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                clearPersistedDraft(tenant);
                setRestorable(null);
              }}
            >
              {t('restoreNo')}
            </Button>
          </div>
        </Alert>
      )}

      <section aria-labelledby="etapa-titulo" className="flex flex-col gap-6">
        {step === 0 && <StepAnonymity headingRef={headingRef} allowAnonymous={allowAnonymous} />}
        {step === 1 && <StepFacts headingRef={headingRef} form={form} errors={fieldErrors} onBlurValidate={(f) => BLUR_FIELDS.includes(f) && void trigger(f)} />}
        {step === 2 && <StepInvolved headingRef={headingRef} form={form} errors={fieldErrors} />}
        {step === 3 && (
          <StepAttachments
            headingRef={headingRef}
            files={draft.files}
            warnings={fileWarnings}
            onAdd={addFiles}
            onRemove={(i) => draft.setFiles(draft.files.filter((_, j) => j !== i))}
            persist={draft.persist}
            onPersist={(p) => {
              draft.setPersist(p);
              if (!p) clearPersistedDraft(tenant);
            }}
          />
        )}
        {step === 4 && <StepReview headingRef={headingRef} form={form} errors={fieldErrors} files={draft.files} onEdit={goTo} />}
      </section>

      {submitError && (
        <Alert tone="danger">
          <p>{submitError}</p>
        </Alert>
      )}

      {/* Barra fixa no rodapé: Voltar / Continuar. Sem navegação lateral competindo pela atenção. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface px-safe pb-safe pt-3 no-print">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="secondary" onClick={() => goTo(step - 1)} disabled={submitting}>
                {tc('back')}
              </Button>
            )}
            <Button variant="ghost" onClick={exit} disabled={submitting}>
              {t('exit')}
            </Button>
          </div>
          {last ? (
            <Button size="lg" onClick={submit} loading={submitting} disabled={!allowAnonymous}>
              {submitting ? t('step4.submitting') : t('step4.submit')}
            </Button>
          ) : (
            <Button size="lg" onClick={next} disabled={!allowAnonymous}>
              {tc('continue')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
