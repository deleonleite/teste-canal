'use client';

import { Alert, Badge, Button, Card, EmptyState, Skeleton } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CircleAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { toast } from 'sonner';

import { CRITICAL_NOTIFICATIONS } from '@ouvion/contracts';
import { apiMessage, staffApi, type NotificationItem } from '@/lib/staff-client';

export function NotificationsView({ tenant }: { tenant: string }) {
  const t = useTranslations('notifs');
  const locale = useLocale();
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const q = useQuery({ queryKey: ['notifications', tenant], queryFn: () => api.get<NotificationItem[]>('notifications'), refetchInterval: 60_000 });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['notifications', tenant] }), qc.invalidateQueries({ queryKey: ['unread', tenant] })]);
  const readOne = useMutation({ mutationFn: (id: string) => api.post(`notifications/${id}/read`), onSuccess: refresh, onError: (e) => toast.error(apiMessage(e) ?? t('loadError')) });
  const readAll = useMutation({ mutationFn: () => api.post('notifications/read-all'), onSuccess: refresh });

  const unread = q.data?.filter((n) => !n.isRead).length ?? 0;
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1">{t('title')}</h1>
          <p className="text-fg-2" aria-live="polite">
            {q.data ? t('unreadCount', { count: unread }) : ' '}
          </p>
        </div>
        <Button variant="secondary" disabled={unread === 0} loading={readAll.isPending} onClick={() => readAll.mutate()} data-testid="notif-read-all">
          {t('markAll')}
        </Button>
      </div>

      {q.isPending && <Skeleton className="h-24 w-full" />}
      {q.isError && <Alert tone="danger">{t('loadError')}</Alert>}
      {q.data && q.data.length === 0 && <EmptyState icon={Bell}>{t('empty')}</EmptyState>}
      {q.data && q.data.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="notif-list">
          {q.data.map((n) => (
            <li key={n.id}>
              <Card className={n.isRead ? 'flex flex-col gap-2 p-4' : 'flex flex-col gap-2 border-brand p-4'}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{n.title}</span>
                  {!n.isRead && <span className="rounded-sm bg-tint-info px-2 py-0.5 text-body-sm font-medium text-info">{t('unread')}</span>}
                  {(CRITICAL_NOTIFICATIONS as readonly string[]).includes(n.type) && (
                    <Badge tone="danger" icon={CircleAlert}>
                      {t('critical')}
                    </Badge>
                  )}
                </div>
                <p className="whitespace-pre-wrap break-words">{n.message}</p>
                <p className="text-body-sm text-fg-3">{fmt(n.createdAt)}</p>
                <div className="flex flex-wrap gap-2">
                  {n.relatedType === 'complaint' && n.relatedId && (
                    <Button asChild variant="ghost">
                      <Link href={`/${tenant}/painel/casos/${n.relatedId}`} className="no-underline hover:no-underline">
                        {t('openCase')}
                      </Link>
                    </Button>
                  )}
                  {!n.isRead && (
                    <Button variant="ghost" onClick={() => readOne.mutate(n.id)}>
                      {t('markOne')}
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
