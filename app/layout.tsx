import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Athena Scheduler',
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
    <html lang="pt-BR">
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
          <symbol id="icon-activity" viewBox="0 0 24 24"><path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" /></symbol>
        </svg>
        {children}
      </body>
    </html>
  );
}
