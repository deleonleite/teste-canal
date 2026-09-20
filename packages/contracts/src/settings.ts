import { z } from 'zod';

/** Chaves conhecidas por tenant; `isPublic` define o que o canal público pode ler (§5.9). */
export const SETTING_KEYS = {
  companyName: { public: true },
  companyLogo: { public: true },
  companyPhone: { public: true },
  companyEmail: { public: true },
  primaryColor: { public: true },
  secondaryColor: { public: true },
  privacyPolicy: { public: true },
  termsOfService: { public: true },
  dpoName: { public: true },
  dpoEmail: { public: true },
  allowAnonymousComplaints: { public: true },
  maintenanceMode: { public: true },
  docCodigoEtica: { public: true },
  docPoliticaFornecedores: { public: true },
  docPoliticaAnticorrupcao: { public: true },
  docPoliticaLicitacoes: { public: true },
  docPoliticaPldFtp: { public: true },
  docPoliticaAssedio: { public: true },
  emailNotifications: { public: false },
  systemAlerts: { public: false },
  max_file_size_mb: { public: false },
  encrypt_complaint_body: { public: false },
  data_retention_days: { public: false },
  sla_ack_days: { public: false },
  sla_feedback_days: { public: false },
  /** Tipos restritos por regra (lista separada por vírgula), ex.: HARASSMENT,CORRUPTION */
  restrictedTypes: { public: false },
  auto_ack_message: { public: false },
  sla_by_priority: { public: false },
  retaliationFollowUpDays: { public: false },
  routingRules: { public: false },
} as const satisfies Record<string, { public: boolean }>;
export type SettingKey = keyof typeof SETTING_KEYS;

export const isSettingKey = (k: string): k is SettingKey => k in SETTING_KEYS;

export const updateSettingSchema = z.object({ value: z.string().max(20000) }).strict();

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB');
const httpUrl = z
  .string()
  .max(500)
  .regex(/^https?:\/\/[^\s]+$/i, 'Informe um endereço http(s)')
  .nullable();

/** Marca do tenant editável pelo ADMIN. `customCss` fica de fora até existir sanitização. */
export const updateBrandingSchema = z
  .object({
    companyName: z.string().trim().min(2).max(120).optional(),
    primaryColor: hexColor.optional(),
    secondaryColor: hexColor.optional(),
    logoUrl: httpUrl.optional(),
    faviconUrl: httpUrl.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nenhum campo informado');
export type UpdateBrandingInput = z.infer<typeof updateBrandingSchema>;
