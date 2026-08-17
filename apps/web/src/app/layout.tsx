import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'SocialHub_B6 | Social Media Management & Publishing',
    template: '%s | SocialHub_B6',
  },
  description:
    'SocialHub_B6 is a social media management and publishing platform for creators and teams.',
  applicationName: 'SocialHub_B6',
  keywords: [
    'SocialHub_B6',
    'social media management',
    'social media publishing',
    'content scheduling',
    'social media scheduling',
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
