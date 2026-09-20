import { TENANT_STATUSES_WITH_STAFF_LOGIN, type TenantStatus } from '@ouvion/contracts';

/** Regras de status do tenant (doc de negócio §3). */
export const TenantAccessPolicy = {
  /** Suspenso, cancelado ou inativo bloqueia o login da equipe. */
  canStaffLogin(tenant: { status: TenantStatus; isActive: boolean }): boolean {
    return tenant.isActive && TENANT_STATUSES_WITH_STAFF_LOGIN.includes(tenant.status);
  },
  /** O canal público nunca deixa de receber relatos por status ou inadimplência. */
  canReceivePublicComplaints(): boolean {
    return true;
  },
};
