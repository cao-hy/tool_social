import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy | SocialHub',
  description:
    'Privacy Policy for SocialHub, a social media management and publishing service operated by b6-teams.',
};

export default function PrivacyPolicyPage() {
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
            <Link href="/terms" className="text-sm font-medium text-slate-600 hover:text-brand-600">
              Terms
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
            Privacy Policy
          </h1>

          <p className="mt-4 text-sm text-slate-500">Effective date: August 11, 2026</p>

          <div className="mt-10 space-y-10 text-[15px] leading-8 text-slate-600">
            <section>
              <h2 className="text-xl font-bold text-slate-950">1. About this Privacy Policy</h2>

              <p className="mt-3">
                This Privacy Policy explains how SocialHub, operated by b6-teams, collects, uses,
                stores, and shares information when you use the SocialHub website and social media
                management services.
              </p>

              <p className="mt-3">
                SocialHub allows users to connect authorized social media accounts, prepare and
                manage content, schedule posts, publish content, and review publishing activity from
                one workspace.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">2. Information We Process</h2>

              <p className="mt-3">
                Depending on the features you use, SocialHub may process the following categories of
                information:
              </p>

              <ul className="mt-4 list-disc space-y-2 pl-6">
                <li>
                  <strong className="text-slate-800">Account information:</strong> your name, email
                  address, account identifier, workspace membership, and account settings.
                </li>

                <li>
                  <strong className="text-slate-800">Connected social account information:</strong>{' '}
                  account identifiers, usernames, display names, profile information, and other
                  information made available through the applicable platform APIs.
                </li>

                <li>
                  <strong className="text-slate-800">Authorization information:</strong>{' '}
                  authorization credentials or tokens required to maintain a connection with a
                  social platform.
                </li>

                <li>
                  <strong className="text-slate-800">Content information:</strong> videos, images,
                  captions, titles, descriptions, publishing settings, scheduled publishing times,
                  and other content you provide to SocialHub.
                </li>

                <li>
                  <strong className="text-slate-800">Publishing information:</strong> publishing
                  requests, platform responses, post identifiers, processing states, publishing
                  results, and error information.
                </li>

                <li>
                  <strong className="text-slate-800">Technical and security information:</strong> IP
                  address, request information, browser or device information, security events, and
                  service logs where necessary to operate and protect SocialHub.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">3. Social Platform Integrations</h2>

              <p className="mt-3">
                SocialHub integrates with third-party social media platforms. A social account is
                connected only when a user initiates and completes the applicable platform
                authorization process.
              </p>

              <p className="mt-3">
                When you connect a platform such as TikTok, Facebook, Instagram, YouTube, or
                Pinterest, SocialHub may receive and process information made available by that
                platform according to the permissions you authorize.
              </p>

              <p className="mt-3">
                SocialHub uses this information only to provide functionality related to the
                connected account, such as identifying the account, preparing content, uploading
                content, publishing content, and retrieving publishing status where supported.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">4. How We Use Information</h2>

              <p className="mt-3">We may use information processed through SocialHub to:</p>

              <ul className="mt-4 list-disc space-y-2 pl-6">
                <li>Create and maintain your SocialHub account.</li>
                <li>Provide and manage workspaces.</li>
                <li>Connect social accounts that you authorize.</li>
                <li>Prepare, schedule, upload, and publish content at your direction.</li>
                <li>Display publishing and processing status.</li>
                <li>Maintain account and service security.</li>
                <li>Detect abuse, fraud, and technical problems.</li>
                <li>Provide customer support.</li>
                <li>Comply with applicable legal and regulatory obligations.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">5. Publishing Content</h2>

              <p className="mt-3">
                SocialHub does not require you to make every piece of content public. Available
                privacy, visibility, and publishing options depend on the destination platform and
                the options that platform makes available to the connected account.
              </p>

              <p className="mt-3">
                When you choose to publish content, SocialHub sends the information required for
                that publishing action to the selected third-party platform.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">6. How Information Is Shared</h2>

              <p className="mt-3">
                Information may be shared only as reasonably necessary to operate SocialHub,
                including:
              </p>

              <ul className="mt-4 list-disc space-y-2 pl-6">
                <li>
                  With a social platform when you connect an account or request an action involving
                  that platform.
                </li>

                <li>
                  With infrastructure and service providers that help operate, secure, store, or
                  deliver the SocialHub service.
                </li>

                <li>
                  When required by applicable law, legal process, or a valid government request.
                </li>

                <li>
                  When reasonably necessary to investigate abuse, fraud, security threats, or
                  violations of our terms.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">7. Data Retention</h2>

              <p className="mt-3">
                We retain information for as long as reasonably necessary to provide SocialHub,
                maintain authorized account connections, complete publishing operations, protect the
                service, resolve disputes, and comply with legal obligations.
              </p>

              <p className="mt-3">
                Some operational, security, audit, or backup information may remain for a limited
                period after other data is deleted where necessary for legitimate security,
                compliance, or technical purposes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">8. Disconnecting Social Accounts</h2>

              <p className="mt-3">
                Users can disconnect social accounts from SocialHub. You may also revoke SocialHub
                access directly from the applicable third-party platform where that platform
                provides account authorization controls.
              </p>

              <p className="mt-3">
                Revoking or disconnecting an account prevents SocialHub from performing new
                authorized actions for that account unless you connect it again.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">
                9. Data Access and Deletion Requests
              </h2>

              <p className="mt-3">
                You may request access to, correction of, or deletion of personal information
                associated with your SocialHub account, subject to applicable law and legitimate
                retention requirements.
              </p>

              <p className="mt-3">To submit a privacy or deletion request, contact:</p>

              <p className="mt-3">
                <a
                  href="mailto:support@b6-team.site"
                  className="font-semibold text-brand-600 hover:text-brand-700"
                >
                  support@b6-team.site
                </a>
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">10. Cookies and Sessions</h2>

              <p className="mt-3">
                SocialHub may use cookies or similar technologies that are necessary for
                authentication, session management, security, and essential service functionality.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">11. Security</h2>

              <p className="mt-3">
                We use reasonable technical and organizational safeguards designed to protect
                information processed by SocialHub against unauthorized access, disclosure,
                alteration, loss, or misuse.
              </p>

              <p className="mt-3">
                No online service or method of electronic storage can guarantee absolute security.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">12. Third-Party Services</h2>

              <p className="mt-3">
                Third-party social platforms and other external services have their own terms and
                privacy practices. Their processing of your information is governed by their
                respective policies.
              </p>

              <p className="mt-3">
                SocialHub is an independent service and is not sponsored, endorsed, or operated by
                the social platforms with which it integrates.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">13. Children</h2>

              <p className="mt-3">
                SocialHub is not intended for children under the age of 13. We do not knowingly
                solicit personal information from children under 13.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">
                14. Changes to this Privacy Policy
              </h2>

              <p className="mt-3">
                We may update this Privacy Policy when our service, integrations, or legal
                obligations change. The effective date displayed at the top of this page indicates
                when this policy was last updated.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-950">15. Contact Us</h2>

              <p className="mt-3">
                If you have questions about this Privacy Policy, SocialHub, or the processing of
                your information, contact b6-teams at:
              </p>

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
              href="/terms"
              className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Terms of Service
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
