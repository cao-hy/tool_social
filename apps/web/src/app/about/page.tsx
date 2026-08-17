import type { Metadata } from 'next';
import {
  OPERATOR_NAME,
  PRODUCT_NAME,
  PUBLIC_DOMAIN,
  SUPPORT_EMAIL,
  PageIntro,
  PublicPageShell,
} from '@/components/public-site';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'About',
  description: `${PRODUCT_NAME} is a social media management and publishing platform developed and operated by ${OPERATOR_NAME}.`,
};

export default function AboutPage() {
  return (
    <PublicPageShell>
      <PageIntro eyebrow="About" title={`${PRODUCT_NAME} is operated by ${OPERATOR_NAME}.`}>
        <p>
          {PRODUCT_NAME} is a social media management and publishing platform developed and operated
          by {OPERATOR_NAME}. It is designed for creators and teams that manage authorized social
          accounts and publishing workflows.
        </p>
      </PageIntro>

      <section className="bg-white py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
          <div>
            <p className="text-sm font-bold text-brand-700">Product identity</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">
              Built for authorized social publishing operations.
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-600">
              The service focuses on helping users connect supported accounts through official
              authorization flows, prepare posts, submit publishing actions, and monitor available
              status or analytics information.
            </p>
          </div>

          <dl className="grid gap-3">
            {[
              ['Product', PRODUCT_NAME],
              ['Operator', OPERATOR_NAME],
              ['Website', PUBLIC_DOMAIN],
              ['Support', SUPPORT_EMAIL],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-slate-200 bg-slate-50 p-4">
                <dt className="text-sm font-bold text-slate-950">{label}</dt>
                <dd className="mt-1 break-words text-sm text-slate-600">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </PublicPageShell>
  );
}
