export const UserRole = ['PUBLIC', 'REPORTER', 'INVESTIGATOR', 'ADMIN', 'AUDITOR', 'SUPER_ADMIN'] as const;
export type UserRole = (typeof UserRole)[number];

export const TenantStatus = ['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED'] as const;
export type TenantStatus = (typeof TenantStatus)[number];

export const ComplaintType = [
  'HARASSMENT', 'DISCRIMINATION', 'FRAUD', 'CORRUPTION', 'SAFETY', 'ETHICS', 'OTHER',
] as const;
export type ComplaintType = (typeof ComplaintType)[number];

export const ComplaintPriority = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ComplaintPriority = (typeof ComplaintPriority)[number];

export const ComplaintStatus = [
  'PENDING', 'IN_PROGRESS', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED', 'ESCALATED',
] as const;
export type ComplaintStatus = (typeof ComplaintStatus)[number];

export const AuditAction = [
  'CREATE', 'READ', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'EXPORT', 'DOWNLOAD', 'BLOCK', 'UNBLOCK',
  'REVEAL_IDENTITY', 'RECUSE', 'REOPEN', 'ACCESS_GRANT', 'LOGIN_FAILED', 'MFA_ENROLL',
  'LEGAL_HOLD', 'BREAK_GLASS_PLATFORM', 'EXTERNAL_ACCESS',
] as const;
export type AuditAction = (typeof AuditAction)[number];

/** Status do tenant em que a equipe pode autenticar (o canal público independe disso). */
export const TENANT_STATUSES_WITH_STAFF_LOGIN: readonly TenantStatus[] = ['TRIAL', 'ACTIVE'];

export const ComplaintSource = ['WEB', 'WHATSAPP', 'PHONE', 'AUDIO', 'EMAIL', 'INTERNAL'] as const;
export type ComplaintSource = (typeof ComplaintSource)[number];

export const CommentVisibility = ['INTERNAL', 'REPORTER'] as const;
export type CommentVisibility = (typeof CommentVisibility)[number];
