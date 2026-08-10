import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'SocialHub | Social Media Management & Publishing',
  description:
    'SocialHub helps creators and teams manage connected social accounts, prepare content, schedule posts, publish content, and track publishing status from one workspace.',
};

const features = [
  {
    number: '01',
    title: 'Connect your accounts',
    description:
      'Connect supported social accounts using each platform’s official authorization flow.',
  },
  {
    number: '02',
    title: 'Prepare your content',
    description:
      'Upload media, write captions, configure publishing options, and organize content in one workspace.',
  },
  {
    number: '03',
    title: 'Schedule or publish',
    description:
      'Review your content and selected account before scheduling or submitting a publishing action.',
  },
  {
    number: '04',
    title: 'Track publishing status',
    description:
      'Follow the status of submitted posts and identify publishing issues that may need attention.',
  },
];

const capabilities = [
  'Social account management',
  'Content scheduling',
  'Direct publishing',
  'Media management',
  'Publishing status',
  'Analytics',
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white text-slate-950">
      {/* HEADER */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex min-h-[72px] max-w-7xl items-center justify-between gap-6 px-5 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-3" aria-label="SocialHub home">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-base font-bold text-white">
              S
            </span>

            <span className="text-lg font-bold tracking-tight">SocialHub</span>
          </Link>

          <nav
            className="hidden items-center gap-8 text-sm font-medium text-slate-600 md:flex"
            aria-label="Main navigation"
          >
            <a href="#features" className="transition-colors hover:text-brand-600">
              Features
            </a>

            <a href="#how-it-works" className="transition-colors hover:text-brand-600">
              How it works
            </a>

            <a href="#security" className="transition-colors hover:text-brand-600">
              Security
            </a>
          </nav>

          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="hidden text-sm font-semibold text-slate-700 transition-colors hover:text-brand-600 sm:inline-flex"
            >
              Sign in
            </Link>

            <Link
              href="/register"
              className="inline-flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Create account
            </Link>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="overflow-hidden border-b border-slate-200 bg-gradient-to-b from-white to-slate-50">
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 py-20 sm:px-6 sm:py-24 lg:grid-cols-[1.08fr_0.92fr] lg:gap-20 lg:px-8 lg:py-28">
          <div>
            <span className="inline-flex rounded-full border border-brand-100 bg-brand-50 px-3 py-2 text-xs font-bold uppercase tracking-[0.12em] text-brand-700">
              Social media management platform
            </span>

            <h1 className="mt-6 max-w-3xl text-5xl font-bold leading-[1.04] tracking-[-0.045em] text-slate-950 sm:text-6xl lg:text-7xl">
              Manage your social content from one workspace.
            </h1>

            <p className="mt-7 max-w-2xl text-lg leading-8 text-slate-600">
              SocialHub helps creators and teams connect authorized social accounts, prepare
              content, schedule posts, publish content, and track publishing activity from a single
              workspace.
            </p>

            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                href="/login"
                className="inline-flex min-h-13 items-center justify-center gap-3 rounded-xl bg-brand-600 px-6 text-sm font-bold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-brand-700"
              >
                Open SocialHub
                <span aria-hidden="true">→</span>
              </Link>

              <a
                href="#how-it-works"
                className="inline-flex min-h-13 items-center justify-center rounded-xl border border-slate-300 bg-white px-6 text-sm font-bold text-slate-800 transition hover:border-slate-400 hover:bg-slate-50"
              >
                How it works
              </a>
            </div>

            <p className="mt-6 max-w-2xl text-sm leading-6 text-slate-500">
              Social accounts are connected only after authorization by the account owner. Users
              remain in control of the accounts and content they connect to SocialHub.
            </p>
          </div>

          {/* PRODUCT PREVIEW */}
          <div className="relative">
            <div className="absolute -inset-8 -z-10 rounded-full bg-brand-100/60 blur-3xl" />

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-950/10 sm:p-6">
              <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    SocialHub workspace
                  </p>

                  <p className="mt-1 text-sm font-bold text-slate-800">Publishing overview</p>
                </div>

                <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">
                  Ready
                </span>
              </div>

              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Scheduled content
                    </p>

                    <p className="mt-1 text-sm font-bold text-slate-800">Product video</p>
                  </div>

                  <span className="rounded-full bg-brand-100 px-2.5 py-1.5 text-xs font-bold text-brand-700">
                    Scheduled
                  </span>
                </div>

                <div className="mt-4 flex min-h-48 items-center justify-center rounded-2xl border border-slate-200 bg-gradient-to-br from-brand-100 via-slate-100 to-slate-200">
                  <div className="text-center">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white shadow-sm">
                      <span className="text-xl text-brand-600">▶</span>
                    </div>

                    <p className="mt-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
                      Video content
                    </p>
                  </div>
                </div>

                <div className="mt-5 space-y-2">
                  <div className="h-2 w-[92%] rounded-full bg-slate-200" />
                  <div className="h-2 w-[73%] rounded-full bg-slate-200" />
                  <div className="h-2 w-[48%] rounded-full bg-slate-200" />
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-5 rounded-2xl border border-slate-200 p-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Social account
                  </p>

                  <p className="mt-1 text-sm font-bold text-slate-800">Authorized profile</p>
                </div>

                <span className="flex items-center gap-2 whitespace-nowrap text-xs font-bold text-emerald-700">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  Connected
                </span>
              </div>

              <div className="mt-4 flex items-center justify-between px-1">
                <span className="text-xs font-semibold text-slate-500">Ready to publish</span>

                <span className="inline-flex min-h-10 min-w-24 items-center justify-center rounded-xl bg-slate-950 px-4 text-xs font-bold text-white">
                  Publish
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CAPABILITIES */}
      <section className="border-b border-slate-200 bg-white py-9">
        <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
          <p className="text-center text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
            One workspace for your social publishing workflow
          </p>

          <div className="mt-5 flex flex-wrap justify-center gap-2.5">
            {capabilities.map((capability) => (
              <span
                key={capability}
                className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600"
              >
                {capability}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="bg-white py-24 sm:py-28">
        <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-600">Features</p>

            <h2 className="mt-4 text-4xl font-bold tracking-[-0.035em] text-slate-950 sm:text-5xl">
              A clearer way to manage social publishing.
            </h2>

            <p className="mt-5 text-base leading-8 text-slate-600">
              Keep account connections, content preparation, scheduling, publishing, and status
              tracking organized in one place.
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <article className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-lg font-bold text-brand-600">
                01
              </div>

              <h3 className="mt-7 text-lg font-bold">Connected accounts</h3>

              <p className="mt-3 text-sm leading-7 text-slate-600">
                Connect supported social profiles through their official authorization flows and
                manage them from SocialHub.
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-lg font-bold text-brand-600">
                02
              </div>

              <h3 className="mt-7 text-lg font-bold">Content publishing</h3>

              <p className="mt-3 text-sm leading-7 text-slate-600">
                Prepare media, captions, and platform-specific publishing settings before submitting
                content.
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-lg font-bold text-brand-600">
                03
              </div>

              <h3 className="mt-7 text-lg font-bold">Scheduling</h3>

              <p className="mt-3 text-sm leading-7 text-slate-600">
                Organize upcoming posts and manage the content your team plans to publish.
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-lg font-bold text-brand-600">
                04
              </div>

              <h3 className="mt-7 text-lg font-bold">Publishing status</h3>

              <p className="mt-3 text-sm leading-7 text-slate-600">
                Review processing and publishing status after content has been submitted.
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-lg font-bold text-brand-600">
                05
              </div>

              <h3 className="mt-7 text-lg font-bold">Media management</h3>

              <p className="mt-3 text-sm leading-7 text-slate-600">
                Keep uploaded media organized for use in your publishing workflows.
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-lg font-bold text-brand-600">
                06
              </div>

              <h3 className="mt-7 text-lg font-bold">Team workspace</h3>

              <p className="mt-3 text-sm leading-7 text-slate-600">
                Organize users, social accounts, and publishing work inside a shared workspace.
              </p>
            </article>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how-it-works" className="border-y border-slate-200 bg-slate-50 py-24 sm:py-28">
        <div className="mx-auto grid max-w-7xl gap-16 px-5 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-600">
              How it works
            </p>

            <h2 className="mt-4 text-4xl font-bold tracking-[-0.035em] text-slate-950 sm:text-5xl">
              A user-controlled publishing workflow.
            </h2>

            <p className="mt-5 text-base leading-8 text-slate-600">
              SocialHub keeps the connected account, selected content, and publishing action visible
              throughout the workflow.
            </p>

            <Link
              href="/login"
              className="mt-7 inline-flex items-center gap-2 text-sm font-bold text-brand-600 hover:text-brand-700"
            >
              Sign in to SocialHub
              <span aria-hidden="true">→</span>
            </Link>
          </div>

          <div className="space-y-4">
            {features.map((feature) => (
              <article
                key={feature.number}
                className="grid grid-cols-[48px_1fr] gap-4 rounded-2xl border border-slate-200 bg-white p-6"
              >
                <span className="pt-1 text-xs font-extrabold tracking-[0.12em] text-brand-500">
                  {feature.number}
                </span>

                <div>
                  <h3 className="text-lg font-bold tracking-tight text-slate-900">
                    {feature.title}
                  </h3>

                  <p className="mt-2 text-sm leading-7 text-slate-600">{feature.description}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* SECURITY */}
      <section id="security" className="bg-white py-24 sm:py-28">
        <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
          <div className="grid gap-12 rounded-3xl border border-slate-200 p-8 sm:p-10 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16 lg:p-14">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-600">
                Authorization & security
              </p>

              <h2 className="mt-4 text-4xl font-bold tracking-[-0.035em] text-slate-950 sm:text-5xl">
                Your accounts remain under your control.
              </h2>
            </div>

            <div className="divide-y divide-slate-200">
              <div className="pb-6">
                <h3 className="font-bold text-slate-900">Explicit authorization</h3>

                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Social accounts are connected through the applicable platform authorization
                  process.
                </p>
              </div>

              <div className="py-6">
                <h3 className="font-bold text-slate-900">Purpose-limited access</h3>

                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Connected account data is used to provide the SocialHub functionality requested by
                  the user.
                </p>
              </div>

              <div className="pt-6">
                <h3 className="font-bold text-slate-900">Clear publishing intent</h3>

                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Users can review content, the target account, and publishing settings before
                  submitting a publishing action.
                </p>
              </div>
            </div>
          </div>

          <p className="mx-auto mt-8 max-w-3xl text-center text-xs leading-6 text-slate-500">
            SocialHub is an independent social media management service. References to third-party
            social platforms describe integrations only and do not imply sponsorship, endorsement,
            or affiliation.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-white pb-24">
        <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-10 rounded-3xl bg-slate-950 p-8 text-white sm:p-12 lg:flex-row lg:items-center">
            <div className="max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-indigo-300">
                SocialHub
              </p>

              <h2 className="mt-4 text-3xl font-bold tracking-[-0.035em] sm:text-4xl">
                Manage your social publishing workflow in one place.
              </h2>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/login"
                className="inline-flex min-h-12 items-center justify-center rounded-xl bg-white px-5 text-sm font-bold text-slate-950"
              >
                Sign in
              </Link>

              <Link
                href="/register"
                className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/25 px-5 text-sm font-bold text-white transition hover:border-white/50"
              >
                Create account
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-7xl px-5 py-12 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-10 md:flex-row">
            <div>
              <Link href="/" className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 font-bold text-white">
                  S
                </span>

                <span className="text-lg font-bold tracking-tight">SocialHub</span>
              </Link>

              <p className="mt-4 max-w-sm text-sm leading-7 text-slate-500">
                Social media management and publishing for creators and teams.
              </p>

              <p className="mt-2 text-sm text-slate-500">Operated by b6-teams.</p>
            </div>

            <div className="grid grid-cols-2 gap-14">
              <div className="flex flex-col gap-3">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-900">
                  Product
                </span>

                <a href="#features" className="text-sm text-slate-500 hover:text-brand-600">
                  Features
                </a>

                <a href="#how-it-works" className="text-sm text-slate-500 hover:text-brand-600">
                  How it works
                </a>

                <Link href="/login" className="text-sm text-slate-500 hover:text-brand-600">
                  Sign in
                </Link>
              </div>

              <div className="flex flex-col gap-3">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-900">
                  Legal
                </span>

                <Link href="/privacy" className="text-sm text-slate-500 hover:text-brand-600">
                  Privacy Policy
                </Link>

                <Link href="/terms" className="text-sm text-slate-500 hover:text-brand-600">
                  Terms of Service
                </Link>

                <a
                  href="mailto:support@b6-team.site"
                  className="text-sm text-slate-500 hover:text-brand-600"
                >
                  Contact
                </a>
              </div>
            </div>
          </div>

          <div className="mt-10 border-t border-slate-200 pt-6 text-xs text-slate-400">
            © 2026 SocialHub by b6-teams. All rights reserved.
          </div>
        </div>
      </footer>
    </main>
  );
}
