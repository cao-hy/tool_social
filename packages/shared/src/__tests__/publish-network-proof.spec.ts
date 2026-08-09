import { describe, expect, it } from 'vitest';
import { buildPublishNetworkProof } from '../publish-network-proof';

describe('buildPublishNetworkProof', () => {
  it('maps attestation into the shared publish proof without turning unknown into false', () => {
    expect(
      buildPublishNetworkProof({
        egressPolicy: 'PROXY_REQUIRED',
        proxyEnabled: true,
        proxyActive: true,
        countryLock: 'US',
        countryLockSatisfied: true,
        checkOk: true,
        attestation: {
          configVersion: 7,
          proxyFingerprint: 'fingerprint_1',
          checkedAt: '2026-08-10T00:00:00.000Z',
          ip: '203.0.113.10',
          countryCode: 'US',
          country: 'United States',
          city: 'Ashburn',
          provider: 'ipify',
          isp: 'Example ISP',
        },
      }),
    ).toEqual({
      egressPolicy: 'PROXY_REQUIRED',
      proxyEnabled: true,
      proxyActive: true,
      configVersion: 7,
      proxyFingerprint: 'fingerprint_1',
      countryLock: 'US',
      countryLockSatisfied: true,
      attestationCheckedAt: '2026-08-10T00:00:00.000Z',
      attestedExitIp: '203.0.113.10',
      attestedCountryCode: 'US',
      country: 'United States',
      city: 'Ashburn',
      provider: 'ipify',
      isp: 'Example ISP',
      checkOk: true,
    });
  });

  it('keeps missing values null instead of defaulting to false', () => {
    const proof = buildPublishNetworkProof({});
    expect(proof.proxyEnabled).toBeNull();
    expect(proof.proxyActive).toBeNull();
    expect(proof.countryLockSatisfied).toBeNull();
    expect(proof.checkOk).toBeNull();
  });
});
