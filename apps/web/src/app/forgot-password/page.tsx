'use client';

import { useState, type FormEvent } from 'react';
import { AuthLink, AuthPanel } from '@/components/auth-panel';
import { Field, InlineError, PrimaryButton, TextInput } from '@/components/form-controls';
import { useToast } from '@/components/toast-provider';
import { authApi } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/errors';

export default function ForgotPasswordPage() {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setDevToken(null);
    setSubmitting(true);

    const form = new FormData(event.currentTarget);
    try {
      const result = await authApi.forgotPassword({ email: String(form.get('email') ?? '') });
      setAccepted(result.accepted);
      setDevToken(result.devResetToken ?? null);
      toast.success('Yêu cầu đặt lại mật khẩu đã được nhận.');
    } catch (submitError) {
      const message = getErrorMessage(submitError);
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPanel
      eyebrow="Khôi phục"
      title="Quên mật khẩu"
      subtitle="Nếu email tồn tại, API sẽ tạo reset token."
      footer={
        <>
          Nhớ mật khẩu rồi? <AuthLink href="/login">Đăng nhập</AuthLink>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field label="Email">
          <TextInput autoComplete="email" name="email" required type="email" />
        </Field>
        <PrimaryButton busy={submitting} className="w-full" type="submit">
          Gửi yêu cầu
        </PrimaryButton>
        <InlineError message={error} />
      </form>
      {accepted ? (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          Yêu cầu đã được nhận.
          {devToken ? (
            <p className="mt-2 break-all font-mono text-xs text-emerald-900">{devToken}</p>
          ) : null}
          {devToken ? (
            <p className="mt-2">
              <AuthLink href={`/reset-password?token=${encodeURIComponent(devToken)}`}>
                Đặt mật khẩu mới
              </AuthLink>
            </p>
          ) : null}
        </div>
      ) : null}
    </AuthPanel>
  );
}
