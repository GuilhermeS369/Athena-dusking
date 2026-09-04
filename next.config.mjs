/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.cdninstagram.com',
      },
    ],
  },
  // Páginas institucionais estáticas (public/*.html) servidas em URL limpa.
  // Exigidas na submissão do app na Meta: política de privacidade, termos e
  // instruções de exclusão de dados do usuário.
  async rewrites() {
    return [
      // A raiz é o site institucional: a verificação de negócio da Meta procura
      // razão social, CNPJ, endereço e telefone no domínio informado, e o
      // painel autenticado vive em /painel.
      { source: '/', destination: '/home.html' },
      { source: '/privacidade', destination: '/privacidade.html' },
      { source: '/termos', destination: '/termos.html' },
      { source: '/exclusao-de-dados', destination: '/exclusao-de-dados.html' },
    ];
  },
  async redirects() {
    return [
      // /sobre foi absorvida pela raiz.
      { source: '/sobre', destination: '/', permanent: true },
    ];
  },
};

export default nextConfig;
