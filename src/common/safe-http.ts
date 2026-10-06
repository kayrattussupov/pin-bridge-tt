import { LookupAddress, lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, Dispatcher } from 'undici';
import { isPublicAddress } from '../images/ip-safety';

/**
 * Outbound HTTP to URLs supplied by agencies (photos, webhooks) must never reach our own
 * network (SSRF). These helpers are shared by every such client.
 */

export const BLOCKED_HOST_CODE = 'EBLOCKEDHOST';

export type UrlProblem = 'invalid_url' | 'blocked_host';

/**
 * Validates scheme, credentials and literal IPs (which never go through DNS). Hostnames are
 * checked at connect time by the dispatcher below.
 */
export function checkOutboundUrl(
  raw: string,
  allowPrivateHosts: boolean,
): { url: URL } | { problem: UrlProblem } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: 'invalid_url' };
  }
  const protocols = allowPrivateHosts ? ['https:', 'http:'] : ['https:'];
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    return { problem: 'invalid_url' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivateHosts && (host === 'localhost' || (isIP(host) && !isPublicAddress(host)))) {
    return { problem: 'blocked_host' };
  }
  return { url };
}

/**
 * An undici dispatcher whose DNS lookup refuses non-public addresses. Because the check runs
 * inside the socket's own lookup, a DNS-rebinding answer cannot differ between check and connect.
 */
export function createSafeDispatcher(options: {
  allowPrivateHosts: boolean;
  connectTimeoutMs: number;
}): Dispatcher {
  const safeLookup = (
    hostname: string,
    lookupOptions: object,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }
      const list = addresses as LookupAddress[];
      if (
        !options.allowPrivateHosts &&
        (list.length === 0 || list.some((a) => !isPublicAddress(a.address)))
      ) {
        callback(
          Object.assign(new Error(`${hostname} resolves to a non-public address`), {
            code: BLOCKED_HOST_CODE,
          }),
          [],
        );
        return;
      }
      if ((lookupOptions as { all?: boolean }).all) {
        callback(null, list);
      } else {
        callback(null, list[0]!.address, list[0]!.family);
      }
    });
  };
  return new Agent({
    connect: { timeout: options.connectTimeoutMs, lookup: safeLookup },
    keepAliveTimeout: 10_000,
  });
}

export function errorCodeOf(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | undefined)?.code;
  if (typeof own === 'string') {
    return own;
  }
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return cause && cause !== error ? errorCodeOf(cause) : undefined;
}
