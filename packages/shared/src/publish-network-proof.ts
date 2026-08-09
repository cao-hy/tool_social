export interface PublishNetworkProof {
  egressPolicy: 'DIRECT_ALLOWED' | 'PROXY_REQUIRED' | 'BLOCKED' | null;
  proxyEnabled: boolean | null;
  proxyActive: boolean | null;
  configVersion: number | null;
  proxyFingerprint: string | null;
  countryLock: string | null;
  countryLockSatisfied: boolean | null;
  attestationCheckedAt: string | null;
  attestedExitIp: string | null;
  attestedCountryCode: string | null;
  country: string | null;
  city: string | null;
  provider: string | null;
  isp: string | null;
  checkOk: boolean | null;
}

export interface PublishNetworkProofInput {
  egressPolicy?: PublishNetworkProof['egressPolicy'];
  proxyEnabled?: boolean | null;
  proxyActive?: boolean | null;
  configVersion?: number | null;
  proxyFingerprint?: string | null;
  countryLock?: string | null;
  countryLockSatisfied?: boolean | null;
  attestation?: {
    configVersion?: number | null;
    proxyFingerprint?: string | null;
    checkedAt?: string | null;
    ip?: string | null;
    countryCode?: string | null;
    country?: string | null;
    city?: string | null;
    provider?: string | null;
    isp?: string | null;
  } | null;
  checkOk?: boolean | null;
}

export function buildPublishNetworkProof(input: PublishNetworkProofInput): PublishNetworkProof {
  return {
    egressPolicy: input.egressPolicy ?? null,
    proxyEnabled: input.proxyEnabled ?? null,
    proxyActive: input.proxyActive ?? null,
    configVersion: input.configVersion ?? input.attestation?.configVersion ?? null,
    proxyFingerprint: input.proxyFingerprint ?? input.attestation?.proxyFingerprint ?? null,
    countryLock: input.countryLock ?? null,
    countryLockSatisfied: input.countryLockSatisfied ?? null,
    attestationCheckedAt: input.attestation?.checkedAt ?? null,
    attestedExitIp: input.attestation?.ip ?? null,
    attestedCountryCode: input.attestation?.countryCode ?? null,
    country: input.attestation?.country ?? null,
    city: input.attestation?.city ?? null,
    provider: input.attestation?.provider ?? null,
    isp: input.attestation?.isp ?? null,
    checkOk: input.checkOk ?? null,
  };
}
