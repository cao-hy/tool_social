import { describe, expect, it } from 'vitest';

// Mô phỏng lại type và logic của assertPublishNetworkReady
interface PublishNetworkProof {
  checkedAt: string;
  ip: string | null;
  countryCode: string | null;
  country: string | null;
  city: string | null;
  isp: string | null;
  provider: string | null;
  checkOk: boolean;
  checkError: string | null;
  checkErrors: string[];
  proxyEnabled: boolean;
  proxyAvailable: boolean;
  proxyActive: boolean;
  countryLock: string | null;
  countryLockSatisfied: boolean;
}

function assertPublishNetworkReady(networkProof: PublishNetworkProof): void {
  if (!networkProof.proxyEnabled) {
    return;
  }

  if (!networkProof.proxyAvailable) {
    throw new Error(
      'Proxy đang bật nhưng chưa có Proxy URL. Publish bị chặn để tránh lộ IP máy chủ.',
    );
  }

  if (!networkProof.countryLock) {
    return;
  }

  if (networkProof.checkOk !== true || !networkProof.proxyActive || !networkProof.countryCode) {
    throw new Error('Country Lock thất bại: Không thể xác minh IP proxy trước khi publish.');
  }

  if (!networkProof.countryLockSatisfied) {
    throw new Error(
      `Country Lock bị vi phạm: IP proxy là ${networkProof.countryCode} ` +
        `(dự kiến: ${networkProof.countryLock}).`,
    );
  }
}

describe('assertPublishNetworkReady', () => {
  const baseProof: PublishNetworkProof = {
    checkedAt: new Date().toISOString(),
    ip: '127.0.0.1',
    countryCode: null,
    country: null,
    city: null,
    isp: null,
    provider: null,
    checkOk: true,
    checkError: null,
    checkErrors: [],
    proxyEnabled: false,
    proxyAvailable: false,
    proxyActive: false,
    countryLock: null,
    countryLockSatisfied: true,
  };

  it('allows if proxy is disabled', () => {
    expect(() => assertPublishNetworkReady({ ...baseProof })).not.toThrow();
  });

  it('throws if proxy is enabled but missing proxy URL', () => {
    expect(() =>
      assertPublishNetworkReady({
        ...baseProof,
        proxyEnabled: true,
        proxyAvailable: false,
      }),
    ).toThrowError('Proxy đang bật nhưng chưa có Proxy URL');
  });

  it('allows if proxy is enabled, URL is present, and no country lock', () => {
    expect(() =>
      assertPublishNetworkReady({
        ...baseProof,
        proxyEnabled: true,
        proxyAvailable: true,
      }),
    ).not.toThrow();
  });

  it('throws if proxy is enabled, country lock is on, but check failed', () => {
    expect(() =>
      assertPublishNetworkReady({
        ...baseProof,
        proxyEnabled: true,
        proxyAvailable: true,
        countryLock: 'US',
        checkOk: false,
      }),
    ).toThrowError('Không thể xác minh IP proxy trước khi publish');
  });

  it('throws if proxy is enabled, country lock is on, but country does not match', () => {
    expect(() =>
      assertPublishNetworkReady({
        ...baseProof,
        proxyEnabled: true,
        proxyAvailable: true,
        proxyActive: true,
        countryLock: 'US',
        countryCode: 'VN',
        checkOk: true,
        countryLockSatisfied: false,
      }),
    ).toThrowError('Country Lock bị vi phạm: IP proxy là VN (dự kiến: US)');
  });

  it('allows if proxy is enabled, country lock is on, and country matches', () => {
    expect(() =>
      assertPublishNetworkReady({
        ...baseProof,
        proxyEnabled: true,
        proxyAvailable: true,
        proxyActive: true,
        countryLock: 'US',
        countryCode: 'US',
        checkOk: true,
        countryLockSatisfied: true,
      }),
    ).not.toThrow();
  });
});
