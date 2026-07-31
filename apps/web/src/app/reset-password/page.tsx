'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { AuthLink, AuthPanel } from '@/components/auth-panel';
import {
  Field,
  InlineError,
  PasswordInput,
  PrimaryButton,
  TextInput,
} from '@/components/form-controls';
import { authApi } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/errors';

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <AuthPanel
          eyebrow="Khôi phục"
          title="Đặt mật khẩu mới"
          subtitle="Đang mở form đặt lại mật khẩu."
          footer={null}
        >
          <p className="text-sm text-slate-600">Đang tải...</p>
        </AuthPanel>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setChanged(false);
    setSubmitting(true);

    const form = new FormData(event.currentTarget);
    try {
      await authApi.resetPassword({
        token: String(form.get('token') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      setChanged(true);
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPanel
      eyebrow="Khôi phục"
      title="Đặt mật khẩu mới"
      subtitle="Mật khẩu mới sẽ làm mất hiệu lực các session cũ."
      footer={
        <>
          Hoàn tất? <AuthLink href="/login">Đăng nhập</AuthLink>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field label="Reset token">
          <TextInput
            defaultValue={searchParams.get('token') ?? ''}
            name="token"
            required
            type="text"
          />
        </Field>
        <Field label="Mật khẩu mới">
          <PasswordInput autoComplete="new-password" minLength={6} name="password" required />
        </Field>
        <PrimaryButton busy={submitting} className="w-full" type="submit">
          Cập nhật mật khẩu
        </PrimaryButton>
        <InlineError message={error} />
      </form>
      {changed ? (
        <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Mật khẩu đã được cập nhật.
        </p>
      ) : null}
    </AuthPanel>
  );
}
