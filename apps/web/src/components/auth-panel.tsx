import Link from 'next/link';
import type { ReactNode } from 'react';

export function AuthPanel({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <section className="w-full max-w-md rounded-lg border border-border-subtle bg-white p-6 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-brand-600">{eyebrow}</p>
        <h1 className="text-2xl font-semibold text-slate-950">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">{subtitle}</p>
        <div className="mt-6">{children}</div>
        <div className="mt-6 border-t border-slate-200 pt-4 text-sm text-slate-600">{footer}</div>
      </section>
    </main>
  );
}

export function AuthLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className="font-medium text-brand-700 hover:text-brand-600" href={href}>
      {children}
    </Link>
  );
}
