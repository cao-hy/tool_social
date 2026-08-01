'use client';

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
import { useToast } from '@/components/toast-provider';
import { ApiClientError, authApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import { getSafeNextPath, withNextParam } from '@/lib/redirects';

function optionalFormText(form: FormData, field: string): string | undefined {
  const value = String(form.get(field) ?? '').trim();
  return value.length > 0 ? value : undefined;
}

export default function RegisterPage() {
  const router = useRouter();
  const auth = useAuth();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [conflictEmail, setConflictEmail] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!auth.loading && auth.user) router.replace(getSafeNextPath());
  }, [auth.loading, auth.user, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setConflictEmail(null);
    setSubmitting(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    const confirmPassword = String(form.get('confirmPassword') ?? '');

    if (password !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp.');
      toast.warning('Mật khẩu xác nhận không khớp.');
      setSubmitting(false);
      return;
    }

    try {
      const payload = await authApi.register({
        email,
        password,
        name: optionalFormText(form, 'name'),
        workspaceName: optionalFormText(form, 'workspaceName'),
      });
      auth.applyAuthPayload(payload);
      toast.success('Đăng ký thành công.');
      router.replace(getSafeNextPath());
    } catch (submitError) {
      if (submitError instanceof ApiClientError && submitError.status === 409) {
        const message = 'Email này đã có tài khoản. Hãy đăng nhập hoặc đặt lại mật khẩu.';
        setConflictEmail(email);
        setError(message);
        toast.warning(message);
      } else {
        const message = getErrorMessage(submitError);
        setError(message);
        toast.error(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPanel
      eyebrow="Phase 2"
      title="Tạo tài khoản"
      subtitle="Tài khoản mới sẽ có workspace mặc định với vai trò Owner."
      footer={
        <>
          Đã có tài khoản?{' '}
          <AuthLink href={withNextParam('/login', getSafeNextPath())}>Đăng nhập</AuthLink>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field label="Tên">
          <TextInput autoComplete="name" name="name" placeholder="Nguyễn An" />
        </Field>
        <Field label="Email">
          <TextInput autoComplete="email" name="email" required type="email" />
        </Field>
        <Field label="Workspace">
          <TextInput name="workspaceName" placeholder="Marketing team" />
        </Field>
        <Field label="Mật khẩu">
          <PasswordInput autoComplete="new-password" minLength={6} name="password" required />
        </Field>
        <Field label="Xác nhận mật khẩu">
          <PasswordInput
            autoComplete="new-password"
            minLength={6}
            name="confirmPassword"
            required
          />
        </Field>
        <PrimaryButton busy={submitting} className="w-full" type="submit">
          Đăng ký
        </PrimaryButton>
        <InlineError message={error} />
        {conflictEmail ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">{conflictEmail}</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <AuthLink href="/login">Đăng nhập</AuthLink>
              <AuthLink href={`/forgot-password?email=${encodeURIComponent(conflictEmail)}`}>
                Quên mật khẩu
              </AuthLink>
            </div>
          </div>
        ) : null}
      </form>
    </AuthPanel>
  );
}
