/** Marca e dados públicos do tenant (resposta de GET /public/branding). Tipo compartilhado servidor/cliente. */
export interface Branding {
  slug: string;
  companyName: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  loginBackgroundUrl: string | null;
  dpo: { name: string | null; email: string | null } | null;
  allowAnonymousComplaints: boolean;
  maintenanceMode: boolean;
  contact: { phone: string | null; email: string | null };
  documents: Record<string, string | null>;
  privacyPolicy: string | null;
  termsOfService: string | null;
}
