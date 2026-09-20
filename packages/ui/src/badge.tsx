import {
  Archive,
  ArrowUpRight,
  Ban,
  CheckCheck,
  CheckCircle2,
  ChevronsUp,
  ChevronUp,
  Clock,
  Equal,
  Eye,
  FileSearch,
  Minus,
  Pause,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from './cn';

type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'critical';

const TONE: Record<Tone, string> = {
  success: 'bg-tint-success text-success',
  danger: 'bg-tint-danger text-danger',
  warning: 'bg-tint-warning text-warning',
  info: 'bg-tint-info text-info',
  neutral: 'bg-tint-neutral text-neutral',
  critical: 'bg-tint-critical text-critical',
};

/** Pílula com ÍCONE + TEXTO, nunca só cor (WCAG 1.4.1; paleta testada para daltonismo). */
export function Badge({ tone, icon: Icon, children, className }: { tone: Tone; icon: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-1 text-body-sm font-medium', TONE[tone], className)}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {children}
    </span>
  );
}

const STATUS: Record<string, { tone: Tone; icon: LucideIcon }> = {
  PENDING: { tone: 'warning', icon: Clock },
  IN_PROGRESS: { tone: 'info', icon: Eye },
  UNDER_REVIEW: { tone: 'info', icon: FileSearch },
  ESCALATED: { tone: 'warning', icon: ArrowUpRight },
  RESOLVED: { tone: 'success', icon: CheckCircle2 },
  DISMISSED: { tone: 'neutral', icon: Archive },
};
export function StatusBadge({ status, label }: { status: string; label: string }) {
  const s = STATUS[status] ?? { tone: 'neutral' as Tone, icon: Clock };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {label}
    </Badge>
  );
}

const PRIORITY: Record<string, { tone: Tone; icon: LucideIcon }> = {
  CRITICAL: { tone: 'critical', icon: ChevronsUp },
  HIGH: { tone: 'danger', icon: ChevronUp },
  MEDIUM: { tone: 'warning', icon: Equal },
  LOW: { tone: 'neutral', icon: Minus },
};
export function PriorityBadge({ priority, label }: { priority: string; label: string }) {
  const p = PRIORITY[priority] ?? PRIORITY.LOW!;
  return (
    <Badge tone={p.tone} icon={p.icon}>
      {label}
    </Badge>
  );
}

/** Texto relativo ("vence em 2 dias"), não só data absoluta: menos carga cognitiva numa lista de 40 casos. */
const SLA: Record<string, { tone: Tone; icon: LucideIcon }> = {
  ON_TIME: { tone: 'neutral', icon: Timer },
  AT_RISK: { tone: 'warning', icon: TriangleAlert },
  BREACHED: { tone: 'danger', icon: Ban },
  DONE: { tone: 'success', icon: CheckCheck },
  PAUSED: { tone: 'neutral', icon: Pause },
};
export function SlaBadge({ state, label }: { state: string; label: string }) {
  const s = SLA[state] ?? SLA.ON_TIME!;
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {label}
    </Badge>
  );
}

const SCAN: Record<string, { tone: Tone; icon: LucideIcon }> = {
  CLEAN: { tone: 'success', icon: ShieldCheck },
  PENDING: { tone: 'warning', icon: ShieldQuestion },
  INFECTED: { tone: 'danger', icon: ShieldAlert },
  ERROR: { tone: 'danger', icon: ShieldAlert },
};
export function ScanBadge({ status, label }: { status: string; label: string }) {
  const s = SCAN[status] ?? SCAN.PENDING!;
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {label}
    </Badge>
  );
}
