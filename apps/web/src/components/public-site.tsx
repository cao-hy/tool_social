import {
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileText,
  Mail,
  RadioTower,
  ShieldCheck,
  UploadCloud,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const PRODUCT_NAME = 'SocialHub_B6';
export const OPERATOR_NAME = 'b6-teams';
export const PUBLIC_DOMAIN = 'https://social.b6-team.com';
export const PUBLIC_DOMAIN_LABEL = 'social.b6-team.com';
export const SUPPORT_EMAIL = 'support@b6-team.com';
export const LOGO_PATH = '/logo_b6.png';

export const publicNavLinks = [
  { href: '/features', label: 'Features' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
] as const;

export const productCapabilities = [
  {
    icon: Users,
    title: 'Social account management',
    description:
      'Connect supported social accounts through each platform authorization process and manage authorized accounts from one workspace.',
  },
  {
    icon: FileText,
    title: 'Content preparation',
    description:
      'Prepare media, captions, links, hashtags, destination accounts, and available platform-specific publishing options before submission.',
  },
  {
    icon: CalendarClock,
    title: 'Content scheduling',
    description:
      'Organize upcoming posts, save drafts, and schedule publishing workflows where supported by the selected account and integration.',
  },
  {
    icon: UploadCloud,
    title: 'Direct publishing',
    description:
      'Review the destination account, media, caption, privacy settings, and available options before submitting a publishing action.',
  },
  {
    icon: Clock3,
    title: 'Publishing status',
    description:
      'Track submitted content through draft, scheduled, queued, processing, published, partial, and failed states where status is available.',
  },
  {
    icon: RadioTower,
    title: 'Media management',
    description:
      'Upload, preview, reuse, and organize image and video media used in publishing workflows.',
  },
  {
    icon: BarChart3,
    title: 'Analytics',
    description:
      'Where supported by an authorized integration, review available account and content performance information.',
  },
  {
    icon: ShieldCheck,
    title: 'Authorization controls',
    description:
      'Connections and publishing actions are initiated only by authorized users inside the workspace.',
  },
] as const;

export const workflowSteps = [
  {
    title: `Create or sign in to a ${PRODUCT_NAME} account`,
    description:
      'Use the existing account flow to access a workspace for managing social publishing work.',
  },
  {
    title: 'Connect an authorized social account',
    description:
      'Connection occurs through the applicable platform authorization process for supported social platforms.',
  },
  {
    title: 'Prepare content',
    description:
      'Select media, write captions, choose the destination account, and configure available publishing options.',
  },
  {
    title: 'Review the publishing action',
    description:
      'Verify the selected account, content, caption, privacy settings, and scheduling details before submission.',
  },
  {
    title: 'Publish or schedule',
    description:
      'Publishing occurs only after an authorized user requests the action or schedules it for later.',
  },
  {
    title: 'Track status',
    description: `${PRODUCT_NAME} displays available processing or publishing status returned by supported integrations.`,
  },
] as const;

export function PublicHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-3"
          aria-label={`${PRODUCT_NAME} home`}
        >
          <img
            src={LOGO_PATH}
            alt={`${OPERATOR_NAME} logo`}
            className="h-10 w-40 shrink-0 object-cover object-center"
          />
          <span className="truncate text-lg font-bold tracking-tight text-slate-950">
            {PRODUCT_NAME}
          </span>
        </Link>

        <nav
          className="order-3 flex w-full flex-wrap items-center gap-x-5 gap-y-2 text-sm font-semibold text-slate-600 md:order-2 md:w-auto"
          aria-label="Public navigation"
        >
          {publicNavLinks.map((link) => (
            <Link key={link.href} href={link.href} className="hover:text-brand-600">
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="order-2 flex items-center gap-2 md:order-3">
          <Link
            href="/login"
            className="inline-flex h-10 items-center justify-center rounded-md px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="inline-flex h-10 items-center justify-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Create account
          </Link>
        </div>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 sm:px-6 md:grid-cols-[1.25fr_0.75fr_0.75fr] lg:px-8">
        <div>
          <Link href="/" className="flex w-fit items-center gap-3">
            <img
              src={LOGO_PATH}
              alt={`${OPERATOR_NAME} logo`}
              className="h-10 w-40 shrink-0 object-cover object-center"
            />
            <span className="text-lg font-bold tracking-tight text-slate-950">{PRODUCT_NAME}</span>
          </Link>
          <p className="mt-4 max-w-xl text-sm leading-6 text-slate-600">
            {PRODUCT_NAME} is a social media management and publishing platform operated by{' '}
            {OPERATOR_NAME}.
          </p>
          <p className="mt-2 text-sm text-slate-600">Operated by {OPERATOR_NAME}</p>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-600"
          >
            <Mail className="h-4 w-4" />
            {SUPPORT_EMAIL}
          </a>
        </div>

        <div className="flex flex-col gap-3">
          <span className="text-sm font-bold text-slate-950">Product</span>
          {publicNavLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-slate-600 hover:text-brand-600"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <span className="text-sm font-bold text-slate-950">Legal</span>
          <Link href="/privacy" className="text-sm text-slate-600 hover:text-brand-600">
            Privacy Policy
          </Link>
          <Link href="/terms" className="text-sm text-slate-600 hover:text-brand-600">
            Terms of Service
          </Link>
          <Link href="/contact" className="text-sm text-slate-600 hover:text-brand-600">
            Contact
          </Link>
        </div>
      </div>

      <div className="border-t border-slate-200">
        <div className="mx-auto max-w-7xl px-5 py-5 text-xs leading-5 text-slate-500 sm:px-6 lg:px-8">
          <p>
            {PRODUCT_NAME} is an independent social media management service. References to
            third-party platforms describe integrations only and do not imply sponsorship,
            endorsement, or affiliation.
          </p>
          <p className="mt-2">
            © 2026 {PRODUCT_NAME}. A product operated by {OPERATOR_NAME}.
          </p>
        </div>
      </div>
    </footer>
  );
}

export function PublicPageShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-white text-slate-950">
      <PublicHeader />
      {children}
      <PublicFooter />
    </main>
  );
}

export function PageIntro({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-slate-200 bg-white">
      <div className="mx-auto max-w-7xl px-5 py-14 sm:px-6 sm:py-16 lg:px-8">
        <p className="text-sm font-bold text-brand-700">{eyebrow}</p>
        <h1 className="mt-4 max-w-4xl text-4xl font-bold tracking-tight text-slate-950 sm:text-5xl">
          {title}
        </h1>
        <div className="mt-5 max-w-3xl text-base leading-7 text-slate-600">{children}</div>
      </div>
    </section>
  );
}

export function CheckList({ items }: { items: string[] }) {
  return (
    <ul className="grid gap-3">
      {items.map((item) => (
        <li key={item} className="flex gap-3 text-sm leading-6 text-slate-700">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
