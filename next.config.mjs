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
      { source: '/sobre', destination: '/sobre.html' },
      { source: '/privacidade', destination: '/privacidade.html' },
      { source: '/termos', destination: '/termos.html' },
      { source: '/exclusao-de-dados', destination: '/exclusao-de-dados.html' },
    ];
  },
};

export default nextConfig;
