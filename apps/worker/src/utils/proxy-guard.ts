export interface PublishNetworkProof {
  checkedAt: string;
  ip: string | null;
  countryCode: string | null;
  country: string | null;
  city: string | null;
  isp: string | null;
  provider?: string | null;
  checkOk?: boolean;
  checkError?: string | null;
  checkErrors?: string[];
  proxyEnabled: boolean;
  proxyAvailable: boolean;
  proxyActive: boolean;
  countryLock: string | null;
  countryLockSatisfied: boolean;
}

export function assertPublishNetworkReady(networkProof: PublishNetworkProof): void {
  if (!networkProof.proxyEnabled) {
    return;
  }

  if (!networkProof.proxyAvailable) {
    throw new Error(
      'Proxy đang bật nhưng chưa có Proxy URL. Publish bị chặn để tránh lộ IP máy chủ.',
    );
  }

  // Không bật Country Lock thì lỗi kết nối proxy sẽ được platform request xử lý.
  // createProxyAwareFetch đã bảo đảm không fallback direct.
  if (!networkProof.countryLock) {
    return;
  }

  if (networkProof.checkOk !== true || !networkProof.proxyActive || !networkProof.countryCode) {
    throw new Error('Country Lock thất bại: Không thể xác minh IP proxy trước khi publish.');
  }

  if (!networkProof.countryLockSatisfied) {
    throw new Error(
      `Country Lock bị vi phạm: IP proxy là ${networkProof.countryCode} ` +
        `nhưng workspace yêu cầu ${networkProof.countryLock}`,
    );
  }
}
