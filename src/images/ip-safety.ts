import { BlockList, isIP } from 'node:net';

// Everything that is not the public internet: private, loopback, link-local (cloud metadata at
// 169.254.169.254), CGNAT, documentation, benchmarking, multicast and reserved ranges.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  // ::/96 covers ::, ::1 and IPv4-compatible addresses (::a.b.c.d, which URL parsing turns into
  // ::7f00:1); ::ffff:0:0:0/96 IPv4-translated; 2002::/16 6to4, which embeds an IPv4 address;
  // 64:ff9b:1::/48 local-use NAT64. IPv4-mapped (::ffff:a.b.c.d) is judged by its IPv4 part:
  // Node's BlockList applies the IPv4 rules to it (a ::ffff:0:0/96 rule would block all IPv4).
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['2002::', 16],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !blocked.check(address, 'ipv4');
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms: judge the embedded IPv4.
    const mapped = /^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) {
      return isPublicAddress(mapped[2]!);
    }
    return !blocked.check(lower, 'ipv6');
  }
  return false;
}
