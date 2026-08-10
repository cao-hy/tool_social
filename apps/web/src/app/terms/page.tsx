import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service | SocialHub',
  description:
    'Terms of Service for SocialHub, a social media management and publishing service operated by b6-teams.',
};

export default function TermsOfServicePage() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      {/* HEADER */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex min-h-[72px] max-w-5xl items-center justify-between gap-6 px-5 sm:px-6">
          <Link href="/" className="flex items-center gap-3" aria-label="SocialHub home">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 font-bold text-white">
              S
            </span>

            <span className="text-lg font-bold tracking-tight">SocialHub</span>
          </Link>

          <div className="flex items-center gap-4">
            <Link
              href="/privacy"
              className="text-sm font-medium text-slate-600 hover:text-brand-600"
            >
              Privacy
            </Link>

            <Link
              href="/login"
              className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <article className="mx-auto max-w-4xl px-5 py-16 sm:px-6 sm:py-20">
        <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-10 lg:p-12">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-600">Legal</p>

          <h1 className="mt-4 text-4xl font-bold tracking-[-0.035em] text-slate-950 sm:text-5xl">
            Terms of Service
          </h1>

          <p className="mt-4 text-sm text-slate-500">Effective date: August 11, 2026</p>

          <div className="mt-10 space-y-10 text-[15px] leading-8 text-slate-600">
            <section>
              <h2 className="text-xl font-bold text-slate-950">1. Acceptance of Terms</h2>

              <p className="mt-3">
                These Terms of Service govern your access to and use of SocialHub, a social media
                management and publishing service operated by b6-teams.
              </p>

              <p className="mt-3">
                By accessing or using SocialHub, you agree to these Terms. If you do not agree to
                these Terms, you should not use the service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">2. About SocialHub</h2>

              <p className="mt-3">
                SocialHub provides tools for managing authorized social media accounts and related
                publishing workflows. Depending on available integrations and account permissions,
                features may include account connection, media management, content preparation,
                scheduling, publishing, publishing status, and analytics.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">3. Your Account</h2>

              <p className="mt-3">
                You are responsible for providing accurate account information and maintaining the
                security of your SocialHub account.
              </p>

              <p className="mt-3">
                You are responsible for activity performed through your account and for ensuring
                that users you invite to a workspace have appropriate authorization to use it.
              </p>

              <p className="mt-3">
                You must notify us if you reasonably believe that your account has been compromised
                or used without authorization.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">4. Connected Social Accounts</h2>

              <p className="mt-3">
                You may connect supported third-party social media accounts to SocialHub through the
                authorization mechanisms provided for those platforms.
              </p>

              <p className="mt-3">
                You may connect only accounts that you own, control, or are otherwise authorized to
                manage.
              </p>

              <p className="mt-3">
                You are responsible for ensuring that your use of a connected account complies with
                the terms, policies, community guidelines, developer requirements, and other rules
                of the applicable third-party platform.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">5. User Content</h2>

              <p className="mt-3">
                You retain responsibility for videos, images, captions, descriptions, comments,
                metadata, and other content that you upload, submit, schedule, or publish through
                SocialHub.
              </p>

              <p className="mt-3">
                You represent that you have the rights and permissions necessary to use and publish
                the content you submit through SocialHub.
              </p>

              <p className="mt-3">
                You grant SocialHub the limited permission necessary to process, store, transmit,
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
                When you initiate or configure a publishing action, you authorize SocialHub to
                transmit the required content and information to the selected third-party platform.
              </p>

              <p className="mt-3">
                Publication may be delayed, rejected, restricted, or removed by a third-party
                platform based on that platform&apos;s own rules, technical systems, moderation
                decisions, account status, or service availability.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">7. Acceptable Use</h2>

              <p className="mt-3">You may not use SocialHub to:</p>

              <ul className="mt-4 list-disc space-y-2 pl-6">
                <li>Violate applicable law or regulation.</li>

                <li>Access or manage a social account without proper authorization.</li>

                <li>Publish content that you do not have the right to use or distribute.</li>

                <li>
                  Circumvent security, access controls, platform restrictions, rate limits, or
                  authorization mechanisms.
                </li>

                <li>
                  Interfere with, overload, damage, or disrupt SocialHub or connected third-party
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
                SocialHub may integrate with third-party platforms including social media and
                content services.
              </p>

              <p className="mt-3">
                Those services are provided by independent third parties and are governed by their
                own terms, privacy policies, developer policies, availability, and technical
                requirements.
              </p>

              <p className="mt-3">
                SocialHub does not control and cannot guarantee the continued availability,
                behavior, approval process, API functionality, or publishing decisions of
                third-party platforms.
              </p>

              <p className="mt-3">
                SocialHub is an independent service. The availability of an integration does not
                imply that the applicable third-party platform sponsors, endorses, operates, or is
                affiliated with SocialHub or b6-teams.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">9. Service Availability</h2>

              <p className="mt-3">
                We work to keep SocialHub available and reliable, but we do not guarantee
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
                requirements, or supported functionality. SocialHub features may therefore be
                changed, limited, or discontinued when necessary to remain compatible or compliant.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">11. Suspension and Termination</h2>

              <p className="mt-3">
                We may restrict or suspend access when reasonably necessary to protect SocialHub,
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
                SocialHub is provided on an &quot;as available&quot; basis to the extent permitted
                by applicable law.
              </p>

              <p className="mt-3">
                We do not guarantee that every publishing request will be accepted, processed, or
                made publicly available by a third-party platform.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">13. Limitation of Liability</h2>

              <p className="mt-3">
                To the extent permitted by applicable law, b6-teams will not be responsible for
                indirect, incidental, special, consequential, or similar losses arising from the use
                of SocialHub, including losses caused by third-party platform outages, restrictions,
                API changes, moderation decisions, or account actions.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">14. Privacy</h2>

              <p className="mt-3">
                Our handling of information is described in the SocialHub Privacy Policy.
              </p>

              <p className="mt-3">
                <Link href="/privacy" className="font-semibold text-brand-600 hover:text-brand-700">
                  Read the Privacy Policy
                </Link>
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">15. Changes to These Terms</h2>

              <p className="mt-3">
                We may update these Terms when SocialHub, our integrations, or applicable
                requirements change. The effective date at the top of this page identifies the
                latest version.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">16. Contact</h2>

              <p className="mt-3">Questions regarding these Terms or SocialHub may be sent to:</p>

              <p className="mt-3">
                <a
                  href="mailto:support@b6-team.site"
                  className="font-semibold text-brand-600 hover:text-brand-700"
                >
                  support@b6-team.site
                </a>
              </p>
            </section>
          </div>

          <div className="mt-12 flex flex-wrap gap-3 border-t border-slate-200 pt-7">
            <Link
              href="/"
              className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Back to SocialHub
            </Link>

            <Link
              href="/privacy"
              className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Privacy Policy
            </Link>
          </div>
        </div>
      </article>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col justify-between gap-3 px-5 py-8 text-sm text-slate-500 sm:flex-row sm:px-6">
          <span>© 2026 SocialHub by b6-teams.</span>

          <div className="flex gap-5">
            <Link href="/privacy" className="hover:text-brand-600">
              Privacy
            </Link>

            <Link href="/terms" className="hover:text-brand-600">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
