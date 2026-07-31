'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthLink, AuthPanel } from '@/components/auth-panel';
import {
  Field,
  InlineError,
  PasswordInput,
  PrimaryButton,
  TextInput,
} from '@/components/form-controls';
import { authApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import { getSafeNextPath, withNextParam } from '@/lib/redirects';

export default function LoginPage() {
  const router = useRouter();
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!auth.loading && auth.user) router.replace(getSafeNextPath());
  }, [auth.loading, auth.user, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const form = new FormData(event.currentTarget);
    try {
      const payload = await authApi.login({
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      auth.applyAuthPayload(payload);
      router.replace(getSafeNextPath());
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPanel
      eyebrow="SocialHub Manager"
      title="Đăng nhập"
      subtitle="Phiên đăng nhập được giữ trong HTTP-only cookie."
      footer={
        <>
          Chưa có tài khoản?{' '}
          <AuthLink href={withNextParam('/register', getSafeNextPath())}>Đăng ký</AuthLink>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field label="Email">
          <TextInput autoComplete="email" name="email" required type="email" />
        </Field>
        <Field label="Mật khẩu">
          <PasswordInput autoComplete="current-password" name="password" required />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <Link
            className="text-sm font-medium text-brand-700 hover:text-brand-600"
            href="/forgot-password"
          >
            Quên mật khẩu
          </Link>
          <PrimaryButton busy={submitting} type="submit">
            Đăng nhập
          </PrimaryButton>
        </div>
        <InlineError message={error} />
      </form>
    </AuthPanel>
  );
}
