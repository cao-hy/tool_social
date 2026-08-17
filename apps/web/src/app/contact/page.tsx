import type { Metadata } from 'next';
import { Mail } from 'lucide-react';
import {
  OPERATOR_NAME,
  PRODUCT_NAME,
  PUBLIC_DOMAIN_LABEL,
  SUPPORT_EMAIL,
  PageIntro,
  PublicPageShell,
} from '@/components/public-site';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Contact',
  description: `Contact ${PRODUCT_NAME} support at ${SUPPORT_EMAIL}.`,
};

const supportTopics = [
  'account questions',
  'product support',
  'technical problems',
  'privacy requests',
  'data deletion requests',
] as const;

export default function ContactPage() {
  return (
    <PublicPageShell>
      <PageIntro eyebrow="Contact" title={`Contact ${PRODUCT_NAME}`}>
        <p>
          Users can contact support for account questions, product support, technical problems,
          privacy requests, and data deletion requests.
        </p>
      </PageIntro>

      <section className="bg-white py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-5">
            <Mail className="h-6 w-6 text-brand-700" />
            <h2 className="mt-4 text-xl font-bold text-slate-950">Primary support email</h2>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="mt-3 inline-flex break-all text-base font-bold text-brand-700 hover:text-brand-600"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>

          <div className="grid gap-6">
            <div>
              <h2 className="text-xl font-bold text-slate-950">Support topics</h2>
              <ul className="mt-4 grid gap-2">
                {supportTopics.map((topic) => (
                  <li
                    key={topic}
                    className="rounded-md border border-slate-200 px-4 py-3 text-sm text-slate-700"
                  >
                    {topic}
                  </li>
                ))}
              </ul>
            </div>

            <dl className="grid gap-3 sm:grid-cols-3">
              {[
                ['Product', PRODUCT_NAME],
                ['Operator', OPERATOR_NAME],
                ['Website', PUBLIC_DOMAIN_LABEL],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border border-slate-200 p-4">
                  <dt className="text-sm font-bold text-slate-950">{label}</dt>
                  <dd className="mt-1 break-words text-sm text-slate-600">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>
    </PublicPageShell>
  );
}
