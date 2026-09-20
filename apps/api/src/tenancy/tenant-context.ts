import type { UserRole } from '@ouvion/contracts';
import type { ClsStore } from 'nestjs-cls';

/** Chaves gravadas no CLS por request (nestjs-cls). */
export interface TenantClsStore extends ClsStore {
  tenantId?: string;
  tenantStatus?: string;
  userId?: string;
  role?: UserRole;
  externalAccessId?: string;
  externalComplaintId?: string;
  protocolComplaintId?: string;
  sessionId?: string;
}
