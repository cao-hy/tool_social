'use client';

import { hasPermission, PLATFORM_LABELS, PLATFORMS, type Platform } from '@socialhub/shared';
import { useEffect, useState } from 'react';
import { InlineError, PrimaryButton, SecondaryButton } from '@/components/form-controls';
import { socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { SocialAccountView } from '@/lib/types';

export default function AccountsPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;
  const [accounts, setAccounts] = useState<SocialAccountView[]>([]);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState<Platform | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadAccounts(workspaceId: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await socialAccountsApi.list(workspaceId);
      setAccounts(result.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!workspace) return;
    void loadAccounts(workspace.id);
  }, [workspace]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const oauth = params.get('oauth');
    const reason = params.get('reason');

    if (connected) {
      setNotice(`Đã kết nối ${connected}.`);
    } else if (oauth === 'cancelled') {
      setError(oauthReasonMessage(reason) ?? 'Bạn đã hủy luồng kết nối.');
    } else if (oauth === 'timeout') {
      setError('Kết nối quá thời gian chờ. Kiểm tra log API rồi thử lại.');
    } else if (oauth === 'missing-code' || oauth === 'failed') {
      setError(
        oauthReasonMessage(reason) ??
          'Kết nối chưa hoàn tất. Kiểm tra quyền Facebook app và thử lại.',
      );
    }
  }, []);

  async function connect(platform: Platform) {
    if (!workspace) return;
    setConnecting(platform);
    setError(null);
    try {
      const result = await socialAccountsApi.startOAuth(workspace.id, platform);
      window.location.href = result.authorizationUrl;
    } catch (connectError) {
      setError(getErrorMessage(connectError));
      setConnecting(null);
    }
  }

  async function disconnect(accountId: string) {
    if (!workspace) return;
    setError(null);
    try {
      await socialAccountsApi.disconnect(workspace.id, accountId);
      await loadAccounts(workspace.id);
    } catch (disconnectError) {
      setError(getErrorMessage(disconnectError));
    }
  }

  async function testConnection(accountId: string) {
    if (!workspace) return;
    setTesting(accountId);
    setError(null);
    setNotice(null);
    try {
      const result = await socialAccountsApi.testConnection(workspace.id, accountId);
      setNotice(`Kết nối OK: ${result.profile.name}`);
      await loadAccounts(workspace.id);
    } catch (testError) {
      setError(getErrorMessage(testError));
    } finally {
      setTesting(null);
    }
  }

  if (!workspace) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-slate-950">Social Accounts</h1>
        <p className="mt-2 text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>
      </section>
    );
  }

  const canConnect = hasPermission(workspace.role, 'social_account:connect');
  const canDisconnect = hasPermission(workspace.role, 'social_account:disconnect');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-950">Social Accounts</h1>
        <p className="mt-1 text-sm text-slate-600">
          OAuth Phase 3. Facebook dùng Graph API khi backend có credential; nền tảng chưa cấu hình
          vẫn dùng fixture ở local dev.
        </p>
      </header>

      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {notice}
        </div>
      ) : null}
      <InlineError message={error} />

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {PLATFORMS.map((platform) => {
          const account = accounts.find((item) => item.platform === platform);
          return (
            <div key={platform} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex min-h-20 flex-col justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-950">{PLATFORM_LABELS[platform]}</p>
                  <p className="mt-1 text-xs text-slate-500">Capability: chưa xác minh</p>
                </div>
                {account ? (
                  <span className="w-fit rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                    {account.status}
                  </span>
                ) : (
                  <span className="w-fit rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                    Chưa kết nối
                  </span>
                )}
              </div>
              {account ? (
                <div className="mt-4 border-t border-slate-200 pt-3">
                  <p className="truncate text-sm font-medium text-slate-900">{account.name}</p>
                  <p className="truncate text-xs text-slate-500">
                    {account.username ?? account.id}
                  </p>
                  <SecondaryButton
                    className="mt-3 w-full"
                    disabled={testing !== null}
                    onClick={() => void testConnection(account.id)}
                    type="button"
                  >
                    {testing === account.id ? 'Đang kiểm tra...' : 'Test connection'}
                  </SecondaryButton>
                  <SecondaryButton
                    className="mt-2 w-full"
                    disabled={!canDisconnect}
                    onClick={() => void disconnect(account.id)}
                    type="button"
                  >
                    Ngắt kết nối
                  </SecondaryButton>
                </div>
              ) : (
                <PrimaryButton
                  busy={connecting === platform}
                  className="mt-4 w-full"
                  disabled={!canConnect}
                  onClick={() => void connect(platform)}
                  type="button"
                >
                  Kết nối
                </PrimaryButton>
              )}
            </div>
          );
        })}
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-950">Tài khoản đã kết nối</h2>
        </div>
        <div className="divide-y divide-slate-200">
          {accounts.map((account) => (
            <div key={account.id} className="grid gap-2 px-5 py-4 md:grid-cols-[180px_1fr_160px]">
              <p className="font-medium text-slate-950">{PLATFORM_LABELS[account.platform]}</p>
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-900">{account.name}</p>
                <p className="truncate text-xs text-slate-500">{account.scopes.join(', ')}</p>
              </div>
              <p className="text-sm font-medium text-slate-600">{account.status}</p>
            </div>
          ))}
          {!loading && accounts.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-600">Chưa có social account nào.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function oauthReasonMessage(reason: string | null): string | null {
  switch (reason) {
    case 'facebook_permission_not_available':
      return 'Facebook chưa grant pages_read_user_content vào token. Kiểm tra Login Configuration ID trong Facebook Login for Business có quyền này, restart API rồi disconnect/connect lại.';
    case 'platform_network':
      return 'API không gọi được graph.facebook.com trong lúc đổi token. Kiểm tra DNS/VPN/firewall hoặc cấu hình 1.1.1.1 như lần trước, rồi bấm kết nối lại.';
    case 'platform_permission_denied':
      return 'Facebook từ chối quyền OAuth. Với comment inbox, app cần cấp được pages_read_user_content hoặc Page Public Content Access.';
    case 'facebook_auth_invalid':
      return 'Facebook từ chối token OAuth. Hãy kiểm tra App ID/App Secret/API version và redirect URI.';
    case 'invalid_state':
      return 'OAuth state không hợp lệ hoặc đã hết hạn. Hãy bấm kết nối lại từ trang này.';
    case 'session_mismatch':
      return 'Phiên đăng nhập hiện tại không khớp với người bắt đầu OAuth. Hãy đăng nhập lại rồi kết nối.';
    case 'provider_error':
      return 'Facebook từ chối luồng OAuth. Hãy kiểm tra quyền được yêu cầu trong App Dashboard.';
    case 'cancelled':
      return 'Bạn đã hủy luồng kết nối.';
    default:
      return null;
  }
}
