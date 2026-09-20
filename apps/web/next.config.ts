import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@ouvion/ui', '@ouvion/contracts'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' }, // o produto nunca é embutido em iframe de terceiro
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // O protocolo vai na URL da confirmação: nenhum referrer pode carregá-lo para outro site.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // camera=(self): atalho de câmera no upload de anexo.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
        ],
      },
      {
        // Nada da API/BFF (conteúdo de denúncia, mensagem, anexo) pode ficar em cache do navegador ou de CDN.
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },
};

export default withNextIntl(config);
