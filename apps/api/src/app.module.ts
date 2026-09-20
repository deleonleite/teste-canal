import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ClsModule } from 'nestjs-cls';

import { CaseAccessService } from './access/case-access.service';
import { AttachmentsService } from './channel/attachments.service';
import { ChannelController, ChannelPublicController } from './channel/channel.controller';
import { MessagesService } from './channel/messages.service';
import { ProtocolGuard, ProtocolSessionService } from './channel/protocol-session';
import { RateLimitGuard, RateLimiter } from './common/rate-limiter';
import { createStorage, Storage } from './storage/storage';
import { createJobQueue, JobQueue } from './queue/job-queue';
import { AttachmentScanHandler, TenantContext } from './scan/attachment-scan.handler';
import { createScanner, Scanner } from './scan/scanner';
import { AttachmentSweepHandler, JobHandlers } from './worker/handlers';
import { createAnchor, Anchor } from './audit/anchor';
import { AuditController } from './audit/audit.controller';
import { BrandingController, ManageBrandingController } from './branding/branding.controller';
import { AuditIntegrityService } from './audit/integrity.service';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { MfaService } from './auth/mfa.service';
import { RefreshTokensService } from './auth/refresh-tokens.service';
import { SecurityConfig } from './auth/security-config';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { SessionService } from './auth/session.service';
import { CaseManagementController } from './complaints/case-management.controller';
import { CaseManagementService } from './complaints/case-management.service';
import { ComplaintsController } from './complaints/complaints.controller';
import { ComplaintsPublicController } from './complaints/complaints.public.controller';
import { ComplaintsService } from './complaints/complaints.service';
import { ConflictService } from './conflicts/conflict.service';
import { ConflictsController } from './conflicts/conflicts.controller';
import { FieldCipher, Kek, LocalKek } from './crypto/field-cipher';
import { ExternalAccessService } from './external/external-access.service';
import { ExternalController, ExternalGuard } from './external/external.controller';
import { HealthController } from './health/health.controller';
import { createMailer, Mailer } from './mail/mailer';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { SlaService } from './workflow/sla.service';
import { WorkflowController } from './workflow/workflow.controller';
import { WorkflowService } from './workflow/workflow.service';
import { OnboardingController } from './onboarding/onboarding.controller';
import { OnboardingService } from './onboarding/onboarding.service';
import { PrismaService } from './prisma/prisma.service';
import { SettingsController } from './settings/settings.controller';
import { TenantResolutionMiddleware } from './tenancy/tenant-resolution.middleware';
import { UsersController } from './users/users.controller';

@Module({
  imports: [
    ClsModule.forRoot({ global: true }),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_ACCESS_SECRET ?? 'dev-only-change-me-dev-only-change-me',
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    ComplaintsPublicController,
    ComplaintsController,
    UsersController,
    SettingsController,
    AuditController,
    CaseManagementController,
    ConflictsController,
    ExternalController,
    OnboardingController,
    ChannelPublicController,
    ChannelController,
    NotificationsController,
    WorkflowController,
    BrandingController,
    ManageBrandingController,
  ],
  providers: [
    PrismaService,
    AuditService,
    SessionService,
    AuthService,
    MfaService,
    RefreshTokensService,
    SecurityConfig,
    ComplaintsService,
    CaseAccessService,
    CaseManagementService,
    ConflictService,
    ExternalAccessService,
    ExternalGuard,
    OnboardingService,
    { provide: Kek, useClass: LocalKek },
    FieldCipher,
    RateLimiter,
    RateLimitGuard,
    ProtocolSessionService,
    ProtocolGuard,
    MessagesService,
    AttachmentsService,
    { provide: Storage, useFactory: createStorage },
    { provide: JobQueue, useFactory: createJobQueue },
    { provide: Scanner, useFactory: createScanner },
    TenantContext,
    { provide: Anchor, useFactory: createAnchor },
    AuditIntegrityService,
    AttachmentScanHandler,
    AttachmentSweepHandler,
    JobHandlers,
    { provide: Mailer, useFactory: createMailer },
    NotificationsService,
    WorkflowService,
    SlaService,
    JwtAuthGuard,
    RolesGuard,
    TenantResolutionMiddleware,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Tudo exige tenant resolvido, exceto o health check.
    consumer.apply(TenantResolutionMiddleware).exclude('health').forRoutes('*');
  }
}
