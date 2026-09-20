'use client';

import { Alert, Button, CharCounter, Checkbox, Field, Input, Select, Textarea } from '@ouvion/ui';
import { CircleCheck, FileText, Paperclip, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, type ReactNode, type RefObject } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { splitLines } from '@/lib/normalize';
import { todayIso, type ComplaintFormValues, type FieldErrors, type FieldKey } from '@/lib/validation';

type Form = UseFormReturn<ComplaintFormValues>;
type HeadingRef = RefObject<HTMLHeadingElement | null>;

const TYPES = ['HARASSMENT', 'DISCRIMINATION', 'FRAUD', 'CORRUPTION', 'SAFETY', 'ETHICS', 'OTHER'] as const;

function StepTitle({ headingRef, children }: { headingRef: HeadingRef; children: ReactNode }) {
  return (
    <h2 id="etapa-titulo" ref={headingRef} tabIndex={-1} className="text-h1 outline-none">
      {children}
    </h2>
  );
}

// ── Etapa 0 — Anonimato ──────────────────────────────────────────────────────────
export function StepAnonymity({ headingRef, allowAnonymous }: { headingRef: HeadingRef; allowAnonymous: boolean }) {
  const t = useTranslations('form.step0');
  const points = t.raw('points') as string[];
  return (
    <>
      <StepTitle headingRef={headingRef}>{t('title')}</StepTitle>
      {allowAnonymous ? (
        <>
          <p className="text-fg-2">{t('intro')}</p>
          <ul className="flex flex-col gap-3">
            {points.map((p) => (
              <li key={p} className="flex gap-3">
                <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-text" aria-hidden="true" />
                <span className="max-w-prose">{p}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Alert tone="warning" title={t('identifiedOnlyTitle')}>
          <p>{t('identifiedOnlyBody')}</p>
        </Alert>
      )}
    </>
  );
}

// ── Etapa 1 — Dados do fato ──────────────────────────────────────────────────────
export function StepFacts({ headingRef, form, errors, onBlurValidate }: { headingRef: HeadingRef; form: Form; errors: FieldErrors; onBlurValidate: (f: FieldKey) => void }) {
  const t = useTranslations('form.step1');
  const tt = useTranslations('types');
  const tc = useTranslations('common');
  const tv = useTranslations('validation');
  const { register, watch } = form;
  const title = watch('title') ?? '';
  const description = watch('description') ?? '';

  return (
    <>
      <StepTitle headingRef={headingRef}>{t('title')}</StepTitle>

      <Field label={t('type')} error={errors.type}>
        {(a) => (
          <Select {...a} {...register('type')} defaultValue={form.getValues('type')}>
            <option value="">{t('typePlaceholder')}</option>
            {TYPES.map((k) => (
              <option key={k} value={k}>
                {tt(k)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label={t('subject')} hint={t('subjectHint')} error={errors.title}>
        {(a) => (
          <>
            <Input {...a} {...register('title')} autoComplete="off" maxLength={400} />
            <CharCounter value={title.length} max={200} label={tv('counterLabel')} />
          </>
        )}
      </Field>

      <Field label={t('description')} hint={t('descriptionHint')} error={errors.description}>
        {(a) => (
          <>
            <Textarea {...a} {...register('description')} rows={9} />
            <CharCounter value={description.length} max={20000} label={tv('counterLabel')} />
          </>
        )}
      </Field>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label={t('date')} hint={t('dateHint')} error={errors.incidentDate} optional={tc('optional')}>
          {(a) => <Input {...a} type="date" max={todayIso()} {...register('incidentDate', { onBlur: () => onBlurValidate('incidentDate') })} />}
        </Field>
        <Field label={t('location')} hint={t('locationHint')} optional={tc('optional')}>
          {(a) => <Input {...a} {...register('location')} autoComplete="off" />}
        </Field>
      </div>

      <Field label={t('department')} optional={tc('optional')}>
        {(a) => <Input {...a} {...register('department')} autoComplete="off" />}
      </Field>
    </>
  );
}

// ── Etapa 2 — Envolvidos ─────────────────────────────────────────────────────────
export function StepInvolved({ headingRef, form, errors }: { headingRef: HeadingRef; form: Form; errors: FieldErrors }) {
  const t = useTranslations('form.step2');
  const tc = useTranslations('common');
  return (
    <>
      <StepTitle headingRef={headingRef}>{t('title')}</StepTitle>
      <Field label={t('involved')} hint={t('involvedHint')} error={errors.involvedPeople}>
        {(a) => <Textarea {...a} {...form.register('involvedPeople')} rows={4} />}
      </Field>
      <Field label={t('witnesses')} hint={t('witnessesHint')} optional={tc('optional')}>
        {(a) => <Textarea {...a} {...form.register('witnesses')} rows={3} />}
      </Field>
    </>
  );
}

// ── Etapa 3 — Anexos ─────────────────────────────────────────────────────────────
export function StepAttachments({
  headingRef, files, warnings, onAdd, onRemove, persist, onPersist,
}: {
  headingRef: HeadingRef;
  files: File[];
  warnings: string[];
  onAdd: (l: FileList | null) => void;
  onRemove: (i: number) => void;
  persist: boolean;
  onPersist: (p: boolean) => void;
}) {
  const t = useTranslations('form.step3');
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <StepTitle headingRef={headingRef}>{t('title')}</StepTitle>
      <p className="text-fg-2">{t('hint')}</p>
      <Alert tone="info">
        <p>{t('notice')}</p>
      </Alert>

      <div>
        <input
          ref={input}
          type="file"
          multiple
          className="sr-only"
          id="arquivos"
          // Em celular o sistema oferece câmera e galeria direto neste seletor.
          accept=".jpg,.jpeg,.png,.gif,.pdf,.docx,.zip,image/*"
          onChange={(e) => {
            onAdd(e.target.files);
            e.target.value = '';
          }}
          aria-label={t('choose')}
        />
        <Button variant="secondary" onClick={() => input.current?.click()}>
          <Paperclip className="h-4 w-4" aria-hidden="true" />
          {t('choose')}
        </Button>
      </div>

      {warnings.length > 0 && (
        <Alert tone="warning">
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}

      {files.length === 0 ? (
        <p className="text-fg-2">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2">
              <FileText className="h-5 w-5 shrink-0 text-fg-3" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-body-sm text-fg-3">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
              <Button variant="ghost" size="icon" onClick={() => onRemove(i)} aria-label={t('remove', { name: f.name })}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-md border border-line bg-sunken p-4">
        <Checkbox checked={persist} onCheckedChange={(c) => onPersist(c === true)} label={t('persistTitle')} description={t('persistBody')} />
      </div>
    </>
  );
}

// ── Etapa 4 — Revisão ────────────────────────────────────────────────────────────
export function StepReview({ headingRef, form, errors, files, onEdit }: { headingRef: HeadingRef; form: Form; errors: FieldErrors; files: File[]; onEdit: (step: number) => void }) {
  const t = useTranslations('form.step4');
  const tt = useTranslations('types');
  const v = form.watch();
  const empty = t('summaryEmpty');
  const tips = t.raw('noticeTips') as string[];

  const Row = ({ label, value, step }: { label: string; value: ReactNode; step: number }) => (
    <div className="flex flex-col gap-1 border-b border-line py-3 sm:flex-row sm:gap-6">
      <dt className="w-40 shrink-0 text-body-sm font-medium text-fg-2">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-3">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{value}</span>
        <Button variant="ghost" onClick={() => onEdit(step)} aria-label={`${t('edit')}: ${label}`} className="text-brand-text">
          {t('edit')}
        </Button>
      </dd>
    </div>
  );

  return (
    <>
      <StepTitle headingRef={headingRef}>{t('title')}</StepTitle>

      <dl className="rounded-md border border-line bg-surface px-4">
        <Row label={t('summaryType')} value={v.type ? tt(v.type as (typeof TYPES)[number]) : empty} step={1} />
        <Row label={t('summarySubject')} value={v.title || empty} step={1} />
        <Row label={t('summaryDescription')} value={<span className="line-clamp-6">{v.description || empty}</span>} step={1} />
        <Row label={t('summaryDate')} value={v.incidentDate || empty} step={1} />
        <Row label={t('summaryLocation')} value={v.location || empty} step={1} />
        <Row label={t('summaryInvolved')} value={splitLines(v.involvedPeople ?? '').join(', ') || empty} step={2} />
        <Row label={t('summaryWitnesses')} value={splitLines(v.witnesses ?? '').join(', ') || empty} step={2} />
        <Row label={t('summaryFiles')} value={files.length ? files.map((f) => f.name).join(', ') : empty} step={3} />
      </dl>

      {/* Aviso de identificação por conteúdo (§8.2): obrigatório de reconhecer no relato anônimo. */}
      <Alert tone="warning" title={t('noticeTitle')}>
        <p>{t('noticeBody')}</p>
        <p className="mt-2 font-medium">{t('noticeIntro')}</p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      </Alert>

      <div className="flex flex-col gap-2">
        <Checkbox
          checked={v.contentWarningAcknowledged === true}
          onCheckedChange={(c) => form.setValue('contentWarningAcknowledged', c === true, { shouldDirty: true })}
          label={t('noticeAck')}
          aria-describedby={errors.contentWarningAcknowledged ? 'ack-error' : undefined}
          aria-invalid={errors.contentWarningAcknowledged ? true : undefined}
        />
        {errors.contentWarningAcknowledged && (
          <p id="ack-error" role="alert" className="text-body-sm text-danger">
            {errors.contentWarningAcknowledged}
          </p>
        )}
      </div>
    </>
  );
}
