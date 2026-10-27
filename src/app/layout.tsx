import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import { JetBrains_Mono, Vazirmatn } from 'next/font/google';
import './globals.css';

const googleSans = localFont({
  src: [
    { path: '../../public/fonts/GoogleSansText-Regular.woff', weight: '400', style: 'normal' },
    { path: '../../public/fonts/GoogleSansText-Medium.woff', weight: '500', style: 'normal' },
    { path: '../../public/fonts/GoogleSansText-Bold.woff', weight: '700', style: 'normal' },
  ],
  variable: '--font-body',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '600'],
});

const persian = Vazirmatn({
  subsets: ['arabic', 'latin'],
  variable: '--font-fa',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'Qureka',
  description: 'Ask plain-language questions about your databases — safely, read-only.',
  authors: [{ name: 'Mohammad Taheri', url: 'https://taheri.vercel.app' }],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${googleSans.variable} ${mono.variable} ${persian.variable}`}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
