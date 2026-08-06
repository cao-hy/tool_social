import { describe, expect, it } from 'vitest';
import { assertPublishNetworkReady, type PublishNetworkProof } from '../utils/proxy-guard';

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
    ).toThrowError('Country Lock bị vi phạm: IP proxy là VN nhưng workspace yêu cầu US');
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
