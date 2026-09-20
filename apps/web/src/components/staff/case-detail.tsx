'use client';

import { ALLOWED_TRANSITIONS, CLOSED_STATUSES, ComplaintConclusion, type ComplaintStatus } from '@ouvion/contracts';
import { Alert, Button, Card, EmptyState, Field, Input, Mono, PriorityBadge, Select, Skeleton, SlaBadge, StatusBadge, Textarea, cn } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, EyeOff, Lock, MessageSquare, UserCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { longDate } from '@/lib/timeline';
import { apiMessage, staffApi, type CaseDetail, type Comment, type RevealedIdentity, type StaffMessage, type UserRow } from '@/lib/staff-client';
import { AttachmentsTab, RecuseSection, RelatedTab, RestrictionSection, SlaSection } from './case-extras';
import { ConfirmDialog } from './dialog';
import { useMe } from './panel-shell';
import { worstSla } from './case-list';

const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const TABS = ['summary', 'conversation', 'attachments', 'notes', 'related', 'history'] as const;
type Tab = (typeof TABS)[number];
const isClosed = (s: string) => (CLOSED_STATUSES as readonly string[]).includes(s);

function dateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
}

export function CaseDetailView({ tenant, id }: { tenant: string; id: string }) {
  const t = useTranslations('case');
  const ts = useTranslations('status');
  const tt = useTranslations('types');
  const tp = useTranslations('priority');
  const tsla = useTranslations('slaState');
  const locale = useLocale();
  const me = useMe();
  const [tab, setTab] = useState<Tab>('summary');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const q = useQuery({ queryKey: ['case', tenant, id], queryFn: () => staffApi(tenant).get<CaseDetail>(`complaints/${id}`) });

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (q.isError) {
    const gone = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <div className="flex flex-col gap-4">
        <BackLink tenant={tenant} />
        <Alert tone="danger">{gone ? t('notFound') : t('loadError')}</Alert>
      </div>
    );
  }

  const c = q.data;
  const canAct = me.role === 'ADMIN' || me.role === 'INVESTIGATOR';
  const sla = worstSla(c.sla);

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!);
    tabRefs.current[next]?.focus();
  }
  const label: Record<Tab, string> = { summary: t('tabSummary'), conversation: t('tabConversation'), attachments: t('tabAttachments'), notes: t('tabNotes'), related: t('tabRelated'), history: t('tabHistory') };

  return (
    <div className="flex flex-col gap-6">
      <BackLink tenant={tenant} />

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-h1">
            <Mono>{c.protocol}</Mono>
          </h1>
          <StatusBadge status={c.status} label={ts(c.status as ComplaintStatus)} />
          <PriorityBadge priority={c.priority} label={tp(c.priority as (typeof PRIORITIES)[number])} />
          {sla !== 'N/A' && <SlaBadge state={sla} label={tsla(sla as 'ON_TIME')} />}
          {c.isRestricted && (
            <span className="inline-flex items-center gap-1 text-body-sm text-fg-2">
              <Lock className="h-4 w-4" aria-hidden="true" />
              {t('restricted')}
            </span>
          )}
        </div>
        <p className="text-h3 font-medium">{c.title}</p>
        <p className="text-body-sm text-fg-2">
          {tt(c.type as 'FRAUD')} · {t('received', { date: longDate(c.createdAt, locale) })}
        </p>
      </header>

      {!canAct && <Alert tone="info">{t('readOnly')}</Alert>}
      {canAct && <ActionsCard tenant={tenant} c={c} role={me.role} />}

      <div>
        <div role="tablist" aria-label={t('tabSummary')} className="flex gap-1 overflow-x-auto border-b border-line">
          {TABS.map((k, i) => (
            <button
              key={k}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              role="tab"
              id={`tab-${k}`}
              aria-selected={tab === k}
              aria-controls={`panel-${k}`}
              tabIndex={tab === k ? 0 : -1}
              onClick={() => setTab(k)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                'min-h-touch whitespace-nowrap border-b-2 px-4 text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tab === k ? 'border-brand text-fg' : 'border-transparent text-fg-2 hover:text-fg',
              )}
            >
              {label[k]}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="pt-6 focus-visible:outline-none">
          {tab === 'summary' && (
            <div className="flex flex-col gap-6">
              <Summary c={c} />
              <RecuseSection tenant={tenant} id={id} />
            </div>
          )}
          {tab === 'conversation' && <Conversation tenant={tenant} id={id} canSend={canAct} />}
          {tab === 'attachments' && <AttachmentsTab tenant={tenant} id={id} canWrite={canAct} canVerify={me.role === 'ADMIN' || me.role === 'AUDITOR'} />}
          {tab === 'related' && <RelatedTab tenant={tenant} id={id} canLink={canAct} />}
          {tab === 'notes' && <Notes tenant={tenant} id={id} canWrite={canAct} />}
          {tab === 'history' && <History c={c} />}
        </div>
      </div>
    </div>
  );
}

function BackLink({ tenant }: { tenant: string }) {
  const t = useTranslations('case');
  return (
    <Link href={`/${tenant}/painel`} className="inline-flex min-h-touch items-center gap-2 self-start text-body text-fg-2 no-underline hover:text-fg hover:no-underline">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {t('back')}
    </Link>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line py-3 sm:flex-row sm:gap-6">
      <dt className="w-44 shrink-0 text-body-sm font-medium text-fg-2">{label}</dt>
      <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</dd>
    </div>
  );
}

// ── Resumo ───────────────────────────────────────────────────────────────────────
function Summary({ c }: { c: CaseDetail }) {
  const t = useTranslations('case');
  const tco = useTranslations('conclusion');
  const locale = useLocale();
  const none = <span className="text-fg-3">{t('none')}</span>;
  return (
    <div className="flex flex-col gap-6">
      <Alert tone="info">{t('immutableNote')}</Alert>
      <Card className="p-4 sm:p-6">
        <dl>
          <Row label={t('reporter')}>
            <span className="inline-flex items-start gap-2">
              {c.isAnonymous ? <EyeOff className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" /> : <UserCheck className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />}
              {c.isAnonymous ? t('reporterAnonymous') : t('reporterIdentified')}
            </span>
          </Row>
          <Row label={t('description')}>{c.description}</Row>
          <Row label={t('involved')}>{c.involvedPeople.length ? c.involvedPeople.join(', ') : none}</Row>
          <Row label={t('witnesses')}>{c.witnesses.length ? c.witnesses.join(', ') : none}</Row>
          <Row label={t('date')}>{c.incidentDate ? longDate(c.incidentDate, locale) : none}</Row>
          <Row label={t('location')}>{c.location || none}</Row>
          <Row label={t('department')}>{c.department || none}</Row>
        </dl>
      </Card>

      <Card className="flex flex-col gap-3 p-4 sm:p-6">
        <h2 className="text-h3">{t('sla')}</h2>
        <SlaLine label={t('slaAck')} s={c.sla.ack} />
        <SlaLine label={t('slaFeedback')} s={c.sla.feedback} />
        {c.slaPausedAt && <Alert tone="warning">{t('slaPaused', { reason: c.slaPauseReason ?? '' })}</Alert>}
      </Card>

      {c.addenda.length > 0 && (
        <Card className="flex flex-col gap-3 p-4 sm:p-6">
          <h2 className="text-h3">{t('addenda')}</h2>
          <ul className="flex flex-col gap-3">
            {c.addenda.map((a) => (
              <li key={a.id} className="rounded-md bg-sunken p-3">
                <p className="text-body-sm text-fg-2">{dateTime(a.createdAt, locale)}</p>
                <p className="whitespace-pre-wrap break-words">{a.content}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {c.conclusion && (
        <Card className="flex flex-col gap-3 p-4 sm:p-6">
          <h2 className="text-h3">{t('conclusionTitle')}</h2>
          <dl>
            <Row label={t('conclusion')}>{tco(c.conclusion as 'SUBSTANTIATED')}</Row>
            {c.correctiveActions && <Row label={t('correctiveActions')}>{c.correctiveActions}</Row>}
            {c.conclusionNotes && <Row label={t('conclusionNotes')}>{c.conclusionNotes}</Row>}
          </dl>
        </Card>
      )}
    </div>
  );
}

function SlaLine({ label, s }: { label: string; s: { state: string; dueAt: string | null } }) {
  const t = useTranslations('case');
  const tsla = useTranslations('slaState');
  const locale = useLocale();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>{label}</span>
      <span className="flex items-center gap-3">
        {s.dueAt && <span className="text-body-sm text-fg-2">{t('slaDue', { date: longDate(s.dueAt, locale) })}</span>}
        {s.state !== 'N/A' && <SlaBadge state={s.state} label={tsla(s.state as 'ON_TIME')} />}
      </span>
    </div>
  );
}

// ── Ações: situação, atribuição, classificação ───────────────────────────────────
function ActionsCard({ tenant, c, role }: { tenant: string; c: CaseDetail; role: string }) {
  const t = useTranslations('case');
  const ts = useTranslations('status');
  const tco = useTranslations('conclusion');
  const tp = useTranslations('priority');
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const closed = isClosed(c.status);
  const isAdmin = role === 'ADMIN';

  const targets = closed ? (isAdmin ? (['IN_PROGRESS'] as ComplaintStatus[]) : []) : [...ALLOWED_TRANSITIONS[c.status as ComplaintStatus]];
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [corrective, setCorrective] = useState('');
  const [notes, setNotes] = useState('');
  const [escalatedTo, setEscalatedTo] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['case', tenant, c.id] }), qc.invalidateQueries({ queryKey: ['cases', tenant] })]);
  const fail = (e: unknown) => setFormError(e instanceof ApiError && e.status === 403 ? t('forbidden') : (apiMessage(e) ?? t('actionError')));

  const change = useMutation({
    mutationFn: () =>
      api.post(`complaints/${c.id}/status`, {
        status,
        reason: reason.trim(),
        ...(conclusion ? { conclusion } : {}),
        ...(corrective.trim() ? { correctiveActions: corrective.trim() } : {}),
        ...(notes.trim() ? { conclusionNotes: notes.trim() } : {}),
        ...(status === 'ESCALATED' ? { escalatedTo: escalatedTo.trim() } : {}),
      }),
    onSuccess: async () => {
      toast.success(t('statusChanged'));
      setStatus('');
      setReason('');
      setConclusion('');
      setCorrective('');
      setNotes('');
      setEscalatedTo('');
      await refresh();
    },
    onError: fail,
  });

  function submitStatus() {
    const next: Record<string, string> = {};
    if (!status) next.status = t('newStatus');
    if (reason.trim().length < 10) next.reason = t('reasonMin');
    if (isClosed(status) && !conclusion) next.conclusion = t('closeRequired');
    if (status === 'ESCALATED' && escalatedTo.trim().length < 3) next.escalatedTo = t('escalateRequired');
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length === 0) change.mutate();
  }

  return (
    <Card className="flex flex-col gap-6 p-4 sm:p-6">
      <h2 className="text-h3">{t('actions')}</h2>

      <section aria-labelledby="act-status" className="flex flex-col gap-4">
        <h3 id="act-status" className="font-semibold">
          {closed ? t('reopen') : t('changeStatus')}
        </h3>
        {targets.length === 0 ? (
          <p className="text-fg-2">{t('noTransitions')}</p>
        ) : (
          <>
            <Field label={closed ? t('reopen') : t('newStatus')} error={errors.status}>
              {(a) => (
                <Select {...a} value={status} onChange={(e) => setStatus(e.target.value)} data-testid="status-select">
                  <option value="" />
                  {targets.map((s) => (
                    <option key={s} value={s}>
                      {ts(s)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {status === 'ESCALATED' && (
              <Field label={t('escalatedTo')} error={errors.escalatedTo}>
                {(a) => <Input {...a} value={escalatedTo} onChange={(e) => setEscalatedTo(e.target.value)} autoComplete="off" />}
              </Field>
            )}
            {isClosed(status) && (
              <>
                <Field label={t('conclusionField')} error={errors.conclusion}>
                  {(a) => (
                    <Select {...a} value={conclusion} onChange={(e) => setConclusion(e.target.value)} data-testid="conclusion-select">
                      <option value="" />
                      {ComplaintConclusion.map((k) => (
                        <option key={k} value={k}>
                          {tco(k)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={t('correctiveField')} optional="">
                  {(a) => <Textarea {...a} value={corrective} onChange={(e) => setCorrective(e.target.value)} rows={3} />}
                </Field>
                <Field label={t('notesField')} optional="">
                  {(a) => <Textarea {...a} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />}
                </Field>
              </>
            )}
            <Field label={closed ? t('reopenReason') : t('reason')} hint={t('reasonHint')} error={errors.reason}>
              {(a) => <Textarea {...a} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="status-reason" />}
            </Field>
            {formError && <Alert tone="danger">{formError}</Alert>}
            <Button onClick={submitStatus} loading={change.isPending} className="self-start" data-testid="status-apply">
              {t('applyStatus')}
            </Button>
          </>
        )}
      </section>

      {isAdmin && !closed && <AssignSection tenant={tenant} c={c} onDone={refresh} />}
      {!closed && <ClassifySection tenant={tenant} c={c} onDone={refresh} tp={tp} />}
      {!closed && <SlaSection tenant={tenant} c={c} onDone={refresh} />}
      {isAdmin && <RestrictionSection tenant={tenant} c={c} onDone={refresh} />}
      {!c.isAnonymous && <RevealSection tenant={tenant} id={c.id} />}
    </Card>
  );
}

function AssignSection({ tenant, c, onDone }: { tenant: string; c: CaseDetail; onDone: () => Promise<unknown> }) {
  const t = useTranslations('case');
  const api = staffApi(tenant);
  const [investigator, setInvestigator] = useState('');
  const [error, setError] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['investigators', tenant], queryFn: () => api.get<UserRow[]>('users?role=INVESTIGATOR') });
  const assign = useMutation({
    mutationFn: () => api.post(`complaints/${c.id}/assign`, { investigatorId: investigator }),
    onSuccess: async () => {
      toast.success(t('assigned'));
      setInvestigator('');
      await onDone();
    },
    onError: (e) => setError(apiMessage(e) ?? t('actionError')),
  });
  const current = users.data?.find((u) => u.id === c.investigatorId);
  return (
    <section aria-labelledby="act-assign" className="flex flex-col gap-4 border-t border-line pt-6">
      <h3 id="act-assign" className="font-semibold">
        {t('assign')}
      </h3>
      <p className="text-body-sm text-fg-2">
        {t('assignedTo')}: {c.investigatorId ? (current?.fullName ?? '…') : t('unassigned')}
      </p>
      <Field label={t('assignSelect')}>
        {(a) => (
          <Select {...a} value={investigator} onChange={(e) => setInvestigator(e.target.value)} data-testid="assign-select">
            <option value="" />
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button variant="secondary" disabled={!investigator} loading={assign.isPending} onClick={() => (setError(null), assign.mutate())} className="self-start" data-testid="assign-submit">
        {t('assignSubmit')}
      </Button>
    </section>
  );
}

function ClassifySection({ tenant, c, onDone, tp }: { tenant: string; c: CaseDetail; onDone: () => Promise<unknown>; tp: (k: (typeof PRIORITIES)[number]) => string }) {
  const t = useTranslations('case');
  const api = staffApi(tenant);
  const [priority, setPriority] = useState(c.priority);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const changed = priority !== c.priority;
  const save = useMutation({
    mutationFn: () => api.patch(`complaints/${c.id}`, { priority, reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(t('classified'));
      setReason('');
      await onDone();
    },
    onError: (e) => setError(apiMessage(e) ?? t('actionError')),
  });
  return (
    <section aria-labelledby="act-classify" className="flex flex-col gap-4 border-t border-line pt-6">
      <h3 id="act-classify" className="font-semibold">
        {t('classify')}
      </h3>
      <Field label={t('priorityLabel')}>
        {(a) => (
          <Select {...a} value={priority} onChange={(e) => setPriority(e.target.value)} data-testid="priority-select">
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {tp(p)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {changed && (
        <Field label={t('priorityChangeReason')} hint={t('reasonHint')}>
          {(a) => <Textarea {...a} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} data-testid="priority-reason" />}
        </Field>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Button
        variant="secondary"
        disabled={!changed || reason.trim().length < 10}
        loading={save.isPending}
        onClick={() => (setError(null), save.mutate())}
        className="self-start"
        data-testid="priority-submit"
      >
        {t('classify')}
      </Button>
    </section>
  );
}

// ── Conversa com o denunciante ───────────────────────────────────────────────────
function Conversation({ tenant, id, canSend }: { tenant: string; id: string; canSend: boolean }) {
  const t = useTranslations('case');
  const locale = useLocale();
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['messages', tenant, id], queryFn: () => api.get<StaffMessage[]>(`complaints/${id}/messages`), refetchInterval: 30_000 });
  const send = useMutation({
    mutationFn: () => api.post(`complaints/${id}/messages`, { content: text.trim() }),
    onSuccess: async () => {
      toast.success(t('sent'));
      setText('');
      await qc.invalidateQueries({ queryKey: ['messages', tenant, id] });
    },
    onError: (e) => setError(apiMessage(e) ?? t('actionError')),
  });
  return (
    <div className="flex flex-col gap-6">
      {q.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : q.data && q.data.length > 0 ? (
        <ul className="flex flex-col gap-3" data-testid="staff-messages">
          {q.data.map((m) => {
            const mine = m.direction === 'TO_REPORTER';
            return (
              <li key={m.id} className={cn('flex', mine && 'justify-end')}>
                <div className={cn('max-w-[85%] rounded-md border p-3', mine ? 'border-brand bg-surface' : 'border-line bg-sunken')}>
                  <p className="text-body-sm font-medium text-fg-2">{mine ? t('fromCommittee') : t('fromReporter')}</p>
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  <p className="mt-1 text-body-sm text-fg-3">{dateTime(m.createdAt, locale)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState icon={MessageSquare}>{t('noMessages')}</EmptyState>
      )}
      {canSend && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setError(null);
            send.mutate();
          }}
        >
          <Field label={t('messageLabel')} hint={t('conversationHint')}>
            {(a) => <Textarea {...a} value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={5000} data-testid="staff-message-input" />}
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={send.isPending} disabled={!text.trim()} className="self-start" data-testid="staff-message-send">
            {t('send')}
          </Button>
        </form>
      )}
    </div>
  );
}

// ── Notas internas ───────────────────────────────────────────────────────────────
function Notes({ tenant, id, canWrite }: { tenant: string; id: string; canWrite: boolean }) {
  const t = useTranslations('case');
  const locale = useLocale();
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['comments', tenant, id], queryFn: () => api.get<Comment[]>(`complaints/${id}/comments`) });
  const save = useMutation({
    mutationFn: () => api.post(`complaints/${id}/comments`, { content: text.trim(), visibility: 'INTERNAL' }),
    onSuccess: async () => {
      toast.success(t('noteSaved'));
      setText('');
      await qc.invalidateQueries({ queryKey: ['comments', tenant, id] });
    },
    onError: (e) => setError(apiMessage(e) ?? t('actionError')),
  });
  return (
    <div className="flex flex-col gap-6">
      <p className="text-fg-2">{t('notesHint')}</p>
      {q.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : q.data && q.data.length > 0 ? (
        <ul className="flex flex-col gap-3" data-testid="notes-list">
          {q.data.map((n) => (
            <li key={n.id} className="rounded-md border border-line bg-surface p-3">
              <p className="text-body-sm text-fg-2">
                {dateTime(n.createdAt, locale)} · {n.visibility === 'INTERNAL' ? t('visibilityInternal') : t('visibilityReporter')}
              </p>
              <p className="whitespace-pre-wrap break-words">{n.content}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-fg-2">{t('noNotes')}</p>
      )}
      {canWrite && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setError(null);
            save.mutate();
          }}
        >
          <Field label={t('noteLabel')}>
            {(a) => <Textarea {...a} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={5000} data-testid="note-input" />}
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" variant="secondary" loading={save.isPending} disabled={!text.trim()} className="self-start" data-testid="note-submit">
            {t('noteSubmit')}
          </Button>
        </form>
      )}
    </div>
  );
}

// ── Histórico ────────────────────────────────────────────────────────────────────
function History({ c }: { c: CaseDetail }) {
  const t = useTranslations('case');
  const ts = useTranslations('status');
  const locale = useLocale();
  if (c.history.length === 0) return <p className="text-fg-2">{t('historyEmpty')}</p>;
  return (
    <ol className="flex flex-col gap-3" data-testid="history-list">
      {c.history.map((h) => (
        <li key={h.id} className="rounded-md border border-line bg-surface p-3">
          <p className="font-medium">
            {h.previousStatus ? t('historyChange', { from: ts(h.previousStatus as ComplaintStatus), to: ts(h.newStatus as ComplaintStatus) }) : t('historyCreated')}
          </p>
          {h.reason && <p className="text-fg-2">{h.reason}</p>}
          <p className="text-body-sm text-fg-3">{dateTime(h.createdAt, locale)}</p>
        </li>
      ))}
    </ol>
  );
}

// ── Revelar identidade (quebra de vidro, auditada) ───────────────────────────────
function RevealSection({ tenant, id }: { tenant: string; id: string }) {
  const t = useTranslations('reveal');
  const [open, setOpen] = useState(false);
  const [justification, setJustification] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<RevealedIdentity | null>(null);
  const reveal = useMutation({
    mutationFn: () => staffApi(tenant).post<RevealedIdentity>(`complaints/${id}/reveal-identity`, { justification: justification.trim() }),
    onSuccess: (r) => {
      setIdentity(r);
      close();
    },
    onError: (e) => setError(e instanceof ApiError && e.status === 403 ? t('forbidden') : t('error')),
  });
  function close() {
    setOpen(false);
    setJustification('');
    setFieldError(undefined);
    setError(null);
  }
  const none = t('notProvided');
  return (
    <section aria-labelledby="act-reveal" className="flex flex-col gap-4 border-t border-line pt-6">
      <h3 id="act-reveal" className="font-semibold">
        {t('button')}
      </h3>
      {identity ? (
        <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-tint-warning p-4" data-testid="revealed-identity">
          <p className="font-semibold">{t('resultTitle')}</p>
          <dl className="grid gap-1 sm:grid-cols-[8rem_1fr]">
            <dt className="text-fg-2">{t('name')}</dt>
            <dd>{identity.name ?? none}</dd>
            <dt className="text-fg-2">{t('email')}</dt>
            <dd className="break-all">{identity.email ?? none}</dd>
            <dt className="text-fg-2">{t('phone')}</dt>
            <dd>{identity.phone ?? none}</dd>
          </dl>
          <p className="text-body-sm text-fg-2">{t('resultNote')}</p>
          <Button variant="secondary" className="self-start" onClick={() => setIdentity(null)}>
            {t('close')}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" className="self-start" onClick={() => setOpen(true)} data-testid="reveal-open">
          {t('button')}
        </Button>
      )}
      <ConfirmDialog
        open={open}
        title={t('title')}
        confirmLabel={t('confirm')}
        danger
        busy={reveal.isPending}
        onClose={close}
        onConfirm={() => {
          if (justification.trim().length < 20) return setFieldError(t('justificationMin'));
          setFieldError(undefined);
          setError(null);
          reveal.mutate();
        }}
      >
        <Alert tone="warning">{t('warning')}</Alert>
        <Field label={t('justification')} hint={t('justificationHint')} error={fieldError}>
          {(a) => <Textarea {...a} value={justification} onChange={(e) => setJustification(e.target.value)} rows={4} data-testid="reveal-justification" />}
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </ConfirmDialog>
    </section>
  );
}
