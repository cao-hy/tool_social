import { type Dispatcher, ProxyAgent, Pool } from 'undici';
import type { ValidatedProxyEndpoint, ProxyGatewayAddress } from '@socialhub/security';
import QuickLRU from 'quick-lru';
import { createHmac } from 'node:crypto';

export class UnsupportedProxyProtocolError extends Error {
  readonly code = 'UNSUPPORTED_PROXY_PROTOCOL';
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedProxyProtocolError';
  }
}

export interface ProxyRequestLease {
  release(): void;
}

export interface ProxyDispatcherHandle {
  readonly dispatcher: Dispatcher;
  acquireRequestLease(): ProxyRequestLease;
  release(): void;
}

export interface ProxyDispatcherEntry {
  dispatcher: Dispatcher;
  activeRequests: number;
  activeHandles: number;
  lastUsedAt: number;
  evictWhenIdle: boolean;
}

export class ProxyDispatcherPool {
  private dispatchers: QuickLRU<string, ProxyDispatcherEntry>;
  private cleanupTimer: NodeJS.Timeout;
  private isClosed = false;

  constructor(
    private readonly fingerprintSecret: string,
    maxSize = 100,
  ) {
    this.dispatchers = new QuickLRU<string, ProxyDispatcherEntry>({
      maxSize,
      onEviction: (_key, entry) => {
        entry.evictWhenIdle = true;
        this.checkEviction(entry);
      },
    });

    // Cleanup idle connections (15-minute idle TTL)
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.dispatchers.entries()) {
        if (
          entry.activeRequests === 0 &&
          entry.activeHandles === 0 &&
          now - entry.lastUsedAt > 15 * 60 * 1000
        ) {
          entry.evictWhenIdle = true;
          this.checkEviction(entry);
          if (entry.evictWhenIdle && entry.activeRequests === 0 && entry.activeHandles === 0) {
            this.dispatchers.delete(key);
          }
        }
      }
    }, 60000).unref();
  }

  async acquire(endpoint: ValidatedProxyEndpoint): Promise<ProxyDispatcherHandle> {
    if (this.isClosed) throw new Error('ProxyDispatcherPool is closed');

    // Reject SOCKS outright
    if (endpoint.protocol.startsWith('socks')) {
      throw new UnsupportedProxyProtocolError('SOCKS proxy is temporarily disabled.');
    }

    const gatewayAddressesKey = endpoint.gatewayAddresses
      .map((a) => `${a.address}:${a.family}`)
      .sort()
      .join(',');

    const cacheKeySource = `${endpoint.normalizedUrl}|${gatewayAddressesKey}`;
    const key = createHmac('sha256', this.fingerprintSecret).update(cacheKeySource).digest('hex');

    let entry = this.dispatchers.get(key);

    if (!entry) {
      const dispatcher = this.createPinnedHttpProxyDispatcher(endpoint);
      entry = {
        dispatcher,
        activeRequests: 0,
        activeHandles: 0,
        lastUsedAt: Date.now(),
        evictWhenIdle: false,
      };
      this.dispatchers.set(key, entry);
    }

    entry.lastUsedAt = Date.now();
    entry.activeHandles++;

    const targetEntry = entry;
    let handleReleased = false;

    const handle: ProxyDispatcherHandle = {
      dispatcher: targetEntry.dispatcher,
      acquireRequestLease: () => {
        targetEntry.activeRequests++;
        targetEntry.lastUsedAt = Date.now();
        let leaseReleased = false;

        return {
          release: () => {
            if (leaseReleased) return;
            leaseReleased = true;
            targetEntry.activeRequests = Math.max(0, targetEntry.activeRequests - 1);
            targetEntry.lastUsedAt = Date.now();
            this.checkEviction(targetEntry);
          },
        };
      },
      release: () => {
        if (handleReleased) return;
        handleReleased = true;
        targetEntry.activeHandles = Math.max(0, targetEntry.activeHandles - 1);
        targetEntry.lastUsedAt = Date.now();
        this.checkEviction(targetEntry);
      },
    };

    return handle;
  }

  async closeAll(): Promise<void> {
    this.isClosed = true;
    clearInterval(this.cleanupTimer);
    const closePromises: Promise<void>[] = [];
    for (const entry of this.dispatchers.values()) {
      entry.evictWhenIdle = true;
      closePromises.push(entry.dispatcher.close().catch(() => {}));
    }
    this.dispatchers.clear();
    await Promise.allSettled(closePromises);
  }

  private checkEviction(entry: ProxyDispatcherEntry) {
    if (entry.activeRequests === 0 && entry.activeHandles === 0 && entry.evictWhenIdle) {
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

  private createPinnedLookup(expectedHostname: string, gatewayAddresses: ProxyGatewayAddress[]) {
    return (
      hostname: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: any,
      callback: (
        err: NodeJS.ErrnoException | null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        address?: string | any[],
        family?: number,
      ) => void,
    ) => {
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
