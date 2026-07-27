'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthLink, AuthPanel } from '@/components/auth-panel';
import { Field, InlineError, PrimaryButton, TextInput } from '@/components/form-controls';
import { workspaceApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import { withNextParam } from '@/lib/redirects';

export default function AcceptInvitationPage() {
  const auth = useAuth();
  const router = useRouter();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('token') ?? '');
  }, []);

  async function handleAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const workspace = await workspaceApi.acceptInvitation(token);
      window.localStorage.setItem('socialhub.activeWorkspaceId', workspace.id);
      await auth.refresh();
      router.replace('/team');
    } catch (acceptError) {
      setError(getErrorMessage(acceptError));
    } finally {
      setSubmitting(false);
    }
  }

  const nextPath = `/accept-invitation${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  if (auth.loading) {
    return (
      <AuthPanel
        eyebrow="Invitation"
        title="Nhận lời mời"
        subtitle="Đang kiểm tra phiên đăng nhập."
        footer={null}
      >
        <p className="text-sm text-slate-600">Đang tải...</p>
      </AuthPanel>
    );
  }

  if (!auth.user) {
    return (
      <AuthPanel
        eyebrow="Invitation"
        title="Cần đăng nhập"
        subtitle="Bạn phải đăng nhập bằng đúng email được mời để tham gia workspace."
        footer={
          <>
            Chưa có tài khoản?{' '}
            <AuthLink href={withNextParam('/register', nextPath)}>Đăng ký</AuthLink>
          </>
        }
      >
        <AuthLink href={withNextParam('/login', nextPath)}>Đăng nhập để nhận lời mời</AuthLink>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      eyebrow="Invitation"
      title="Nhận lời mời workspace"
      subtitle={`Đang đăng nhập bằng ${auth.user.email}.`}
      footer={
        <>
          Không đúng tài khoản? <AuthLink href="/login">Đăng nhập tài khoản khác</AuthLink>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleAccept}>
        <Field label="Invitation token">
          <TextInput
            name="token"
            required
            type="text"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <PrimaryButton busy={submitting} className="w-full" type="submit">
          Nhận lời mời
        </PrimaryButton>
        <InlineError message={error} />
      </form>
    </AuthPanel>
  );
}
