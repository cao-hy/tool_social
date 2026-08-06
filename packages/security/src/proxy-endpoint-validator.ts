import { isBlockedAddress } from './ssrf-guard';

export interface DnsResolver {
  lookup(
    hostname: string,
    options: { all: true; verbatim: true },
  ): Promise<
    Array<{
      address: string;
      family: number;
    }>
  >;
}

export interface ValidatedProxyEndpoint {
  normalizedUrl: string;
  hostname: string;
  port: number;
  protocol: 'http:' | 'https:' | 'socks:' | 'socks5:';
  resolvedAddresses: Array<{
    address: string;
    family: 4 | 6;
  }>;
  validatedAt: number;
}

export class ProxyEndpointBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyEndpointBlockedError';
  }
}

export class ProxyEndpointValidator {
  constructor(private readonly dnsResolver: DnsResolver) {}

  async validate(rawUrl: string): Promise<ValidatedProxyEndpoint> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ProxyEndpointBlockedError('URL không hợp lệ');
    }

    if (!['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol)) {
      throw new ProxyEndpointBlockedError(`Giao thức proxy không hỗ trợ: ${url.protocol}`);
    }

    const hostname = url.hostname;

    // Kiểm tra nhanh hostname/IP (không thông qua DNS, bắt loopback, local IP)
    if (isBlockedAddress(hostname)) {
      throw new ProxyEndpointBlockedError('Proxy không được trỏ tới địa chỉ nội bộ');
    }

    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await this.dnsResolver.lookup(hostname, { all: true, verbatim: true });
    } catch (_error) {
      throw new ProxyEndpointBlockedError(`Không thể phân giải hostname: ${hostname}`);
    }

    if (addresses.length === 0) {
      throw new ProxyEndpointBlockedError('Không tìm thấy địa chỉ IP nào cho proxy');
    }

    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        throw new ProxyEndpointBlockedError(
          'Hostname proxy phân giải tới địa chỉ nội bộ hoặc không hợp lệ',
        );
      }
    }

    return {
      normalizedUrl: url.toString(),
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80,
      protocol: url.protocol as 'http:' | 'https:' | 'socks:' | 'socks5:',
      resolvedAddresses: addresses as Array<{ address: string; family: 4 | 6 }>,
      validatedAt: Date.now(),
    };
  }
}
