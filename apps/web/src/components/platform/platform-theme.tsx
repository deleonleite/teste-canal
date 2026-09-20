import { brandCss } from '@ouvion/ui';

/** Cor de marca da PRÓPRIA plataforma (nível 1 do design system): azul sóbrio, sem relação com a marca de nenhuma empresa. */
export function PlatformTheme() {
  return <style dangerouslySetInnerHTML={{ __html: brandCss('#1f4e8c', '#8a6d1f') }} />;
}
