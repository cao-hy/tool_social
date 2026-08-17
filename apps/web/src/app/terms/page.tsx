import type { Metadata } from 'next';
import Link from 'next/link';
import {
  OPERATOR_NAME,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  PageIntro,
  PublicPageShell,
} from '@/components/public-site';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: `Terms of Service for ${PRODUCT_NAME}, a social media management and publishing service operated by ${OPERATOR_NAME}.`,
};

export default function TermsOfServicePage() {
  return (
    <PublicPageShell>
      <PageIntro eyebrow="Terms of Service" title="Terms of Service">
        <p>
          These Terms of Service govern access to and use of {PRODUCT_NAME}, a social media
          management and publishing service operated by {OPERATOR_NAME}.
        </p>
        <p className="mt-3 text-sm text-slate-500">Effective date: August 11, 2026</p>
      </PageIntro>

      <article className="mx-auto max-w-4xl px-5 py-14 sm:px-6 sm:py-16">
        <div className="space-y-10 text-[15px] leading-8 text-slate-600">
          <section>
            <h2 className="text-xl font-bold text-slate-950">1. Acceptance of Terms</h2>
            <p className="mt-3">
              These Terms of Service govern your access to and use of {PRODUCT_NAME}, a social media
              management and publishing service operated by {OPERATOR_NAME}.
            </p>
            <p className="mt-3">
              By accessing or using {PRODUCT_NAME}, you agree to these Terms. If you do not agree to
              these Terms, you should not use the service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">2. About {PRODUCT_NAME}</h2>
            <p className="mt-3">
              {PRODUCT_NAME} provides tools for managing authorized social media accounts and
              related publishing workflows. Depending on available integrations and account
              permissions, features may include account connection, media management, content
              preparation, scheduling, publishing, publishing status, and analytics.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">3. Your Account</h2>
            <p className="mt-3">
              You are responsible for providing accurate account information and maintaining the
              security of your {PRODUCT_NAME} account.
            </p>
            <p className="mt-3">
              You are responsible for activity performed through your account and for ensuring that
              users you invite to a workspace have appropriate authorization to use it.
            </p>
            <p className="mt-3">
              You must notify us if you reasonably believe that your account has been compromised or
              used without authorization.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">4. Connected Social Accounts</h2>
            <p className="mt-3">
              You may connect supported third-party social media accounts to {PRODUCT_NAME} through
              the authorization mechanisms provided for those platforms.
            </p>
            <p className="mt-3">
              You may connect only accounts that you own, control, or are otherwise authorized to
              manage.
            </p>
            <p className="mt-3">
              You are responsible for ensuring that your use of a connected account complies with
              the terms, policies, community guidelines, developer requirements, and other rules of
              the applicable third-party platform.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">5. User Content</h2>
            <p className="mt-3">
              You retain responsibility for videos, images, captions, descriptions, comments,
              metadata, and other content that you upload, submit, schedule, or publish through{' '}
              {PRODUCT_NAME}.
            </p>
            <p className="mt-3">
              You represent that you have the rights and permissions necessary to use and publish
              the content you submit through {PRODUCT_NAME}.
            </p>
            <p className="mt-3">
              You grant {PRODUCT_NAME} the limited permission necessary to process, store, transmit,
              and submit your content for the purpose of providing the features you request.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">6. Publishing Actions</h2>
            <p className="mt-3">
              You are responsible for reviewing the destination account, content, captions,
              publishing options, privacy settings, and scheduled time before requesting
              publication.
            </p>
            <p className="mt-3">
              When you initiate or configure a publishing action, you authorize {PRODUCT_NAME} to
              transmit the required content and information to the selected third-party platform.
            </p>
            <p className="mt-3">
              Publication may be delayed, rejected, restricted, or removed by a third-party platform
              based on that platform&apos;s own rules, technical systems, moderation decisions,
              account status, or service availability.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">7. Acceptable Use</h2>
            <p className="mt-3">You may not use {PRODUCT_NAME} to:</p>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>Violate applicable law or regulation.</li>
              <li>Access or manage a social account without proper authorization.</li>
              <li>Publish content that you do not have the right to use or distribute.</li>
              <li>
                Circumvent security, access controls, platform restrictions, rate limits, or
                authorization mechanisms.
              </li>
              <li>
                Interfere with, overload, damage, or disrupt {PRODUCT_NAME} or connected third-party
                services.
              </li>
              <li>
                Use the service for fraud, malicious automation, spam, harassment, abuse, or
                unlawful activity.
              </li>
              <li>
                Attempt to obtain unauthorized access to another user&apos;s account, workspace,
                credentials, or data.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">8. Third-Party Platforms</h2>
            <p className="mt-3">
              {PRODUCT_NAME} may integrate with third-party platforms including social media and
              content services.
            </p>
            <p className="mt-3">
              Those services are provided by independent third parties and are governed by their own
              terms, privacy policies, developer policies, availability, and technical requirements.
            </p>
            <p className="mt-3">
              {PRODUCT_NAME} does not control and cannot guarantee the continued availability,
              behavior, approval process, API functionality, or publishing decisions of third-party
              platforms.
            </p>
            <p className="mt-3">
              {PRODUCT_NAME} is an independent service. The availability of an integration does not
              imply that the applicable third-party platform sponsors, endorses, operates, or is
              affiliated with {PRODUCT_NAME} or {OPERATOR_NAME}.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">9. Service Availability</h2>
            <p className="mt-3">
              We work to keep {PRODUCT_NAME} available and reliable, but we do not guarantee
              uninterrupted or error-free availability.
            </p>
            <p className="mt-3">
              The service may be temporarily unavailable because of maintenance, security work,
              infrastructure failures, third-party service interruptions, API changes, or
              circumstances outside our reasonable control.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">
              10. Changes to Integrations and Features
            </h2>
            <p className="mt-3">
              Third-party platforms may change their APIs, permissions, policies, review
              requirements, or supported functionality. {PRODUCT_NAME} features may therefore be
              changed, limited, or discontinued when necessary to remain compatible or compliant.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">11. Suspension and Termination</h2>
            <p className="mt-3">
              We may restrict or suspend access when reasonably necessary to protect {PRODUCT_NAME},
              other users, connected platforms, or the security and integrity of the service.
            </p>
            <p className="mt-3">
              Access may also be restricted for material violations of these Terms, unlawful
              activity, unauthorized access, abuse, fraud, or security threats.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">12. Disclaimer</h2>
            <p className="mt-3">
              {PRODUCT_NAME} is provided on an &quot;as available&quot; basis to the extent
              permitted by applicable law.
            </p>
            <p className="mt-3">
              We do not guarantee that every publishing request will be accepted, processed, or made
              publicly available by a third-party platform.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">13. Limitation of Liability</h2>
            <p className="mt-3">
              To the extent permitted by applicable law, {OPERATOR_NAME} will not be responsible for
              indirect, incidental, special, consequential, or similar losses arising from the use
              of {PRODUCT_NAME}, including losses caused by third-party platform outages,
              restrictions, API changes, moderation decisions, or account actions.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">14. Privacy</h2>
            <p className="mt-3">
              Our handling of information is described in the {PRODUCT_NAME} Privacy Policy.
            </p>
            <p className="mt-3">
              <Link href="/privacy" className="font-semibold text-brand-700 hover:text-brand-600">
                Read the Privacy Policy
              </Link>
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">15. Changes to These Terms</h2>
            <p className="mt-3">
              We may update these Terms when {PRODUCT_NAME}, our integrations, or applicable
              requirements change. The effective date at the top of this page identifies the latest
              version.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-950">16. Contact</h2>
            <p className="mt-3">
              Questions regarding these Terms or {PRODUCT_NAME} may be sent to:
            </p>
            <p className="mt-3">
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="font-semibold text-brand-700 hover:text-brand-600"
              >
                {SUPPORT_EMAIL}
              </a>
            </p>
          </section>
        </div>

        <div className="mt-12 flex flex-wrap gap-3 border-t border-slate-200 pt-7">
          <Link
            href="/"
            className="rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Back to {PRODUCT_NAME}
          </Link>
          <Link
            href="/privacy"
            className="rounded-md border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Privacy Policy
          </Link>
        </div>
      </article>
    </PublicPageShell>
  );
}
