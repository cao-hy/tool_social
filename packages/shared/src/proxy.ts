export interface ProxyConfig {
  enabled: boolean;
  countryLock: string | null;
  proxyUrl?: string | null;
  proxyUrlMasked?: string | null;
  source?: 'WORKSPACE' | 'ENV' | 'DIRECT';
  version?: string;
}
