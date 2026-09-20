import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

/** Idiomas com dicionário completo. EN/ES entram aqui quando os dicionários existirem (o mecanismo já está pronto). */
export const LOCALES = ['pt'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'pt';

function pick(candidate: string | undefined | null): Locale | null {
  const base = candidate?.toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(base ?? '') ? (base as Locale) : null;
}

/**
 * Idioma sem prefixo na URL (o primeiro segmento é o tenant): cookie NEXT_LOCALE, depois Accept-Language,
 * depois português. Toda mensagem de validação vem do mesmo dicionário do resto da interface.
 */
export default getRequestConfig(async () => {
  const jar = await cookies();
  const accept = (await headers()).get('accept-language')?.split(',')[0];
  const locale = pick(jar.get('NEXT_LOCALE')?.value) ?? pick(accept) ?? DEFAULT_LOCALE;
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
