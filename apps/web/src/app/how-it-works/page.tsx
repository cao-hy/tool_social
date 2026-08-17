import type { Metadata } from 'next';
import { CheckCircle2 } from 'lucide-react';
import { PageIntro, PRODUCT_NAME, PublicPageShell, workflowSteps } from '@/components/public-site';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'How It Works',
  description: `How ${PRODUCT_NAME} helps authorized users connect accounts, prepare content, publish or schedule, and track status.`,
};

export default function HowItWorksPage() {
  return (
    <PublicPageShell>
      <PageIntro eyebrow="How it works" title="A clear workflow for authorized publishing.">
        <p>
          {PRODUCT_NAME} keeps social account authorization, content selection, user review, and
          publishing status visible through the workflow.
        </p>
      </PageIntro>

      <section className="bg-white py-14 sm:py-16">
        <div className="mx-auto grid max-w-5xl gap-4 px-5 sm:px-6">
          {workflowSteps.map((step, index) => (
            <article
              key={step.title}
              className="grid grid-cols-[44px_minmax(0,1fr)] gap-4 rounded-md border border-slate-200 p-5"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-brand-50 text-sm font-bold text-brand-700">
                {index + 1}
              </span>
              <div>
                <h2 className="text-lg font-bold text-slate-950">
                  Step {index + 1} - {step.title}
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">{step.description}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-slate-200 bg-slate-50 py-14 sm:py-16">
        <div className="mx-auto max-w-5xl px-5 sm:px-6">
          <div className="rounded-md border border-slate-200 bg-white p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                <h2 className="text-lg font-bold text-slate-950">Authorization note</h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  {PRODUCT_NAME} does not connect to or publish to social accounts that the user has
                  not authorized. Publishing actions occur only after an authorized user selects the
                  destination account and requests publication or scheduling.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PublicPageShell>
  );
}
