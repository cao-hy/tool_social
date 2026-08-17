import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import {
  PageIntro,
  PRODUCT_NAME,
  PublicPageShell,
  productCapabilities,
} from '@/components/public-site';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Features',
  description: `${PRODUCT_NAME} features for authorized social account management, content preparation, scheduling, publishing, status tracking, media management, and analytics.`,
};

export default function FeaturesPage() {
  return (
    <PublicPageShell>
      <PageIntro eyebrow="Features" title="Product features for social publishing teams.">
        <p>
          {PRODUCT_NAME} brings account connections, content preparation, publishing workflows,
          media, status tracking, and analytics into one workspace for authorized users.
        </p>
      </PageIntro>

      <section className="bg-white py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-4 px-5 sm:px-6 md:grid-cols-2 lg:px-8">
          {productCapabilities.map((feature) => {
            const Icon = feature.icon;
            return (
              <article key={feature.title} className="rounded-md border border-slate-200 p-5">
                <div className="flex items-start gap-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-700">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div>
                    <h2 className="text-lg font-bold text-slate-950">{feature.title}</h2>
                    <p className="mt-2 text-sm leading-7 text-slate-600">{feature.description}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="border-y border-slate-200 bg-slate-50 py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-8">
          <div>
            <p className="text-sm font-bold text-brand-700">Publishing review</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">
              Review destination, content, and options before submission.
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              'Destination account and integration',
              'Prepared media and caption',
              'Available privacy and publishing settings',
              'Scheduled time or immediate publishing action',
            ].map((item) => (
              <div key={item} className="rounded-md border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold leading-6 text-slate-800">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white py-14 sm:py-16">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-5 px-5 sm:px-6 md:flex-row md:items-center lg:px-8">
          <div>
            <p className="text-sm font-bold text-brand-700">{PRODUCT_NAME}</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">
              See the workflow from sign-in to status tracking.
            </h2>
          </div>
          <Link
            href="/how-it-works"
            className="inline-flex h-11 w-fit items-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-bold text-white hover:bg-slate-800"
          >
            How it works
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </PublicPageShell>
  );
}
