import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

import './globals.css';

/**
 * A fonte do painel.
 *
 * O CSS pedia `Inter` desde sempre — e ninguém nunca a carregou. O navegador
 * caía no fallback (Segoe UI no Windows), então a tela era desenhada numa fonte
 * que o projeto não escolheu, com pesos 800-850 e espaçamento negativo que
 * foram calibrados para OUTRA. É por isso que parecia errada em toda parte.
 *
 * `next/font` baixa e serve a fonte do próprio domínio no build: nada de
 * requisição ao Google em tempo de execução, nada de texto invisível esperando
 * download. `swap` garante que o texto apareça na hora com a fonte do sistema
 * e troque quando a Inter chegar.
 *
 * O fallback continua sendo a pilha nativa (`system-ui` e companhia), então
 * mesmo se a fonte falhar a tela sai com a cara do sistema — que é o padrão que
 * um painel deve ter.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-ui',
});

export const metadata: Metadata = {
  title: 'Athena Dusking',
  description: 'Painel de automação e organização de publicações no Instagram.',
  viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
  themeColor: '#0a0a0d',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body>
        <svg className="icon-sprite" aria-hidden="true" width="0" height="0">
          <symbol id="icon-grid" viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></symbol>
          <symbol id="icon-send" viewBox="0 0 24 24"><path d="M20.5 3.5 3.7 10.1c-.8.3-.8 1.4 0 1.7l6.5 2.3 2.3 6.5c.3.8 1.4.8 1.7 0l6.6-16.8c.3-.8-.3-1.5-1.1-1.2Z" /><path d="m10.2 14.1 4.8-4.8" /></symbol>
          <symbol id="icon-image" viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.4" /><path d="m5.5 17 4.2-4.2 3.2 3 2.2-2.3 3.4 3.5" /></symbol>
          <symbol id="icon-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.3" /><path d="M5.5 20c.6-3.2 2.8-5 6.5-5s5.9 1.8 6.5 5" /></symbol>
          <symbol id="icon-users" viewBox="0 0 24 24"><circle cx="9" cy="9" r="3" /><path d="M3.8 20c.5-3 2.2-4.6 5.2-4.6s4.7 1.6 5.2 4.6" /><path d="M15 6.5a3 3 0 0 1 0 5.8M16.2 15.8c2.5.3 3.8 1.7 4.2 4.2" /></symbol>
          <symbol id="icon-calendar" viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="15" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16M8 14h.1M12 14h.1M16 14h.1M8 17.5h.1M12 17.5h.1" /></symbol>
          <symbol id="icon-key" viewBox="0 0 24 24"><circle cx="7.5" cy="12" r="3.5" /><path d="M11 12h9M16 12v3M19 12v2" /></symbol>
          <symbol id="icon-upload" viewBox="0 0 24 24"><path d="M12 15.5V4.5" /><path d="m7.5 9 4.5-4.5L16.5 9" /><path d="M5 15.5v2.8c0 .9.7 1.7 1.7 1.7h10.6c.9 0 1.7-.7 1.7-1.7v-2.8" /></symbol>
          <symbol id="icon-recovery" viewBox="0 0 24 24"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" /><path d="M20.5 4.2v4.6h-4.6" /><path d="M7.6 12.4h2.6l1.5-3 2 6 1.4-3h1.3" /></symbol>
          <symbol id="icon-activity" viewBox="0 0 24 24"><path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" /></symbol>
          <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M20.4 12a8.4 8.4 0 1 1-2.5-6" /><path d="M20.6 4.3v4.6H16" /></symbol>
          <symbol id="icon-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
          <symbol id="icon-chevron" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5" /></symbol>
          <symbol id="icon-logout" viewBox="0 0 24 24"><path d="M10 4.5H6.7C5.8 4.5 5 5.3 5 6.2v11.6c0 .9.8 1.7 1.7 1.7H10" /><path d="m15.5 8 4 4-4 4" /><path d="M19.5 12H10" /></symbol>
          <symbol id="icon-alert" viewBox="0 0 24 24"><path d="M12 4.5 3 19.5h18L12 4.5Z" /><path d="M12 10v4M12 17h.01" /></symbol>
          {/* A marca: a coluna do templo de Atena.

              O caminho até aqui vale registro, porque foi decidido olhando e
              não teorizando. A coruja (Atena Glaucopis, a das moedas de Atenas)
              lia como coruja, mas não como Grécia. O elmo coríntio — o símbolo
              mais direto da deusa — vira mancha a 21px: testado de frente e de
              perfil, com e sem crista, e nos dois casos o desenho perdia a
              silhueta e passava a parecer caveira. O ramo de oliveira, presente
              dela à cidade, some num "folhinha" genérica no tamanho de ícone.

              A coluna sobrevive: aos 150px é clássica, aos 16px continua sendo
              uma coluna. E o vínculo é direto — o Partenon é o templo de Atena.

              Sem moldura de propósito. Ela vivia dentro de um quadrado roxo, e
              quadrado colorido atrás de um ícone é o desenho de 2015; a marca
              agora é a própria forma. */}
          <symbol id="icon-athena" viewBox="0 0 24 24"><path fillRule="evenodd" clipRule="evenodd" d="M4.4 2.4h15.2a1 1 0 0 1 0 2H4.4a1 1 0 0 1 0-2Zm1.3 3.2h12.6a.8.8 0 0 1 0 1.6H5.7a.8.8 0 0 1 0-1.6Zm.8 3h2.3v10.2H6.5V8.6Zm4.35 0h2.3v10.2h-2.3V8.6Zm4.35 0h2.3v10.2h-2.3V8.6ZM4.4 19.6h15.2a1 1 0 0 1 0 2H4.4a1 1 0 0 1 0-2Z" /></symbol>
        </svg>
        {children}
      </body>
    </html>
  );
}
