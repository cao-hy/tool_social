import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileText,
  UploadCloud,
  Users,
} from 'lucide-react';
import {
  OPERATOR_NAME,
  PRODUCT_NAME,
  PublicPageShell,
  productCapabilities,
  workflowSteps,
} from '@/components/public-site';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: {
    absolute: `${PRODUCT_NAME} | Social Media Management & Publishing`,
  },
  description: `${PRODUCT_NAME} is a social media management and publishing platform for creators and teams.`,
};

const overviewStats = [
  { label: 'Authorized account flows', value: 'OAuth' },
  { label: 'Post states', value: 'Draft to status' },
  { label: 'Operator', value: OPERATOR_NAME },
] as const;

const heroWorkflow = [
  { icon: Users, label: 'Authorized accounts' },
  { icon: FileText, label: 'Prepared content' },
  { icon: CalendarClock, label: 'Schedule or publish' },
  { icon: Clock3, label: 'Track status' },
] as const;

export default function HomePage() {
  return (
    <PublicPageShell>
      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-14 sm:px-6 sm:py-16 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:px-8">
          <div>
            <p className="text-sm font-bold text-brand-700">{PRODUCT_NAME}</p>
            <h1 className="mt-4 max-w-4xl text-4xl font-bold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
              Manage your social publishing workflow from one workspace.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
              {PRODUCT_NAME} helps creators and teams connect authorized social accounts, prepare
              content, schedule posts, publish content, and track publishing activity from one
              workspace.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/register"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-brand-600 px-5 text-sm font-bold text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                Create account
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/features"
                className="inline-flex h-12 items-center justify-center rounded-md border border-slate-300 bg-white px-5 text-sm font-bold text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                View features
              </Link>
            </div>
            <p className="mt-6 max-w-2xl text-sm leading-6 text-slate-500">
              {PRODUCT_NAME} is a social media management and publishing platform operated by{' '}
              {OPERATOR_NAME}.
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-4 border-b border-slate-200 pb-4">
              <div>
                <p className="text-sm font-bold text-slate-950">Publishing workspace</p>
                <p className="mt-1 text-xs text-slate-500">Review before submission</p>
              </div>
              <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
                Authorized
              </span>
            </div>

            <div className="mt-5 grid gap-3">
              {heroWorkflow.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.label}
                    className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3 rounded-md border border-slate-200 bg-slate-50 p-3"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white text-brand-700">
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 text-sm font-semibold text-slate-800">
                      {item.label}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="mt-5 rounded-md border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <UploadCloud className="h-4 w-4 text-brand-700" />
                Publishing action
              </div>
              <div className="mt-4 grid gap-2">
                <div className="h-2 w-full rounded-full bg-slate-200" />
                <div className="h-2 w-4/5 rounded-full bg-slate-200" />
                <div className="h-2 w-3/5 rounded-full bg-slate-200" />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="rounded-md bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-700">
                  Destination selected
                </span>
                <span className="rounded-md bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700">
                  Pending user action
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-white py-8">
        <div className="mx-auto grid max-w-7xl gap-3 px-5 sm:px-6 md:grid-cols-3 lg:px-8">
          {overviewStats.map((stat) => (
            <div key={stat.label} className="rounded-md border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-bold text-slate-950">{stat.value}</p>
              <p className="mt-1 text-sm text-slate-600">{stat.label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div>
              <p className="text-sm font-bold text-brand-700">Product</p>
              <h2 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
                Core publishing tools for authorized social accounts.
              </h2>
            </div>
            <Link
              href="/features"
              className="inline-flex h-11 w-fit items-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-bold text-slate-800 hover:bg-slate-50"
            >
              Features
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {productCapabilities.slice(0, 4).map((feature) => {
              const Icon = feature.icon;
              return (
                <article key={feature.title} className="rounded-md border border-slate-200 p-5">
                  <Icon className="h-6 w-6 text-brand-700" />
                  <h3 className="mt-5 text-base font-bold text-slate-950">{feature.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-600">{feature.description}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-y border-slate-200 bg-slate-50 py-16 sm:py-20">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:px-8">
          <div>
            <p className="text-sm font-bold text-brand-700">How it works</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              User-controlled from connection to status.
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-600">
              {PRODUCT_NAME} keeps the connected account, selected content, and publishing request
              visible before a user submits or schedules work.
            </p>
          </div>

          <div className="grid gap-3">
            {workflowSteps.slice(0, 4).map((step, index) => (
              <article
                key={step.title}
                className="grid grid-cols-[36px_minmax(0,1fr)] gap-4 rounded-md border border-slate-200 bg-white p-4"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-50 text-sm font-bold text-brand-700">
                  {index + 1}
                </span>
                <div>
                  <h3 className="font-bold text-slate-950">{step.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{step.description}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 sm:px-6 lg:grid-cols-[1fr_1fr] lg:px-8">
          <div>
            <p className="text-sm font-bold text-brand-700">Authorization</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Independent service, authorized integrations.
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Social platform names are referenced only to describe available integrations.{' '}
              {PRODUCT_NAME} is not owned, sponsored, endorsed, or operated by those platforms.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-5">
            <ul className="grid gap-3">
              {[
                'Accounts connect only through authorization by the account owner or authorized user.',
                'Publishing actions are submitted only after a user selects the target account and content.',
                'Available privacy settings, analytics, and publishing outcomes depend on each third-party platform.',
              ].map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-6 text-slate-700">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-slate-950 py-12 text-white">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-6 px-5 sm:px-6 md:flex-row md:items-center lg:px-8">
          <div>
            <p className="text-sm font-bold text-indigo-200">{PRODUCT_NAME}</p>
            <h2 className="mt-2 max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl">
              Manage your social publishing workflow in one place.
            </h2>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/login"
              className="inline-flex h-11 items-center justify-center rounded-md bg-white px-4 text-sm font-bold text-slate-950 hover:bg-slate-100"
            >
              Sign in
            </Link>
            <Link
              href="/contact"
              className="inline-flex h-11 items-center justify-center rounded-md border border-white/30 px-4 text-sm font-bold text-white hover:border-white"
            >
              Contact
            </Link>
          </div>
        </div>
      </section>
    </PublicPageShell>
  );
}
