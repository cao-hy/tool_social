import { type Dispatcher, ProxyAgent, Pool } from 'undici';
import { Socks5ProxyAgent } from 'undici';
import type { ValidatedProxyEndpoint, ProxyGatewayAddress } from '@socialhub/security';
import QuickLRU from 'quick-lru';

export class ProxyDispatcherLease {
  constructor(
    public readonly dispatcher: Dispatcher,
    private readonly releaseCb: () => void,
  ) {}

  release() {
    this.releaseCb();
  }
}

export interface ProxyDispatcherEntry {
  dispatcher: Dispatcher;
  activeRequests: number;
  lastUsedAt: number;
  evictWhenIdle: boolean;
}

export class ProxyDispatcherPool {
  private dispatchers: QuickLRU<string, ProxyDispatcherEntry>;

  constructor(maxSize = 100) {
    this.dispatchers = new QuickLRU<string, ProxyDispatcherEntry>({
      maxSize,
      onEviction: (_key, entry) => {
        entry.evictWhenIdle = true;
        this.checkEviction(entry);
      },
    });
  }

  async acquire(endpoint: ValidatedProxyEndpoint): Promise<ProxyDispatcherLease> {
    const key = endpoint.normalizedUrl;
    let entry = this.dispatchers.get(key);

    if (!entry) {
      const dispatcher = endpoint.protocol.startsWith('socks')
        ? this.createPinnedSocksProxyDispatcher(endpoint)
        : this.createPinnedHttpProxyDispatcher(endpoint);

      entry = { dispatcher, activeRequests: 0, lastUsedAt: Date.now(), evictWhenIdle: false };
      this.dispatchers.set(key, entry);
    }

    entry.activeRequests++;
    entry.lastUsedAt = Date.now();

    return new ProxyDispatcherLease(entry.dispatcher, () => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      entry!.activeRequests--;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      entry!.lastUsedAt = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.checkEviction(entry!);
    });
  }

  private checkEviction(entry: ProxyDispatcherEntry) {
    if (entry.activeRequests === 0 && entry.evictWhenIdle) {
      entry.dispatcher.close().catch(() => {});
    }
  }

  private createPinnedHttpProxyDispatcher(endpoint: ValidatedProxyEndpoint): Dispatcher {
    return new ProxyAgent({
      uri: endpoint.normalizedUrl,
      clientFactory: (origin, opts) => {
        return new Pool(origin, {
          ...opts,
          connect: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(opts as any).connect,
            lookup: this.createPinnedLookup(endpoint.hostname, endpoint.gatewayAddresses),
          },
        });
      },
    });
  }

  private createPinnedSocksProxyDispatcher(endpoint: ValidatedProxyEndpoint): Dispatcher {
    return new Socks5ProxyAgent(endpoint.normalizedUrl, {
      connect: {
        lookup: this.createPinnedLookup(endpoint.hostname, endpoint.gatewayAddresses),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
  }

  private createPinnedLookup(expectedHostname: string, gatewayAddresses: ProxyGatewayAddress[]) {
    return (
      hostname: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callback: (
        err: NodeJS.ErrnoException | null,
        address?: string | any[],
        family?: number,
      ) => void,
    ) => {
      // Undici passes the proxy hostname to lookup, not the target hostname.
      // So we can assert that it matches the expected proxy hostname.
      if (hostname !== expectedHostname) {
        return callback(
          new Error(`Unexpected lookup for ${hostname} (expected proxy ${expectedHostname})`),
        );
      }

      if (options && options.all) {
        const addrs = gatewayAddresses.map((a) => ({ address: a.address, family: a.family }));
        return callback(null, addrs);
      } else {
        const first = gatewayAddresses[0];
        return callback(null, first ? first.address : undefined, first ? first.family : undefined);
      }
    };
  }
}
