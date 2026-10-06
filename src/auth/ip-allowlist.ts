import { BlockList, isIP } from 'node:net';

/** Accepts `1.2.3.4`, `1.2.3.0/24`, `2001:db8::1`, `2001:db8::/32`. Returns an error or undefined. */
export function validateIpRule(rule: string): string | undefined {
  const [address, prefix, extra] = rule.split('/');
  const family = isIP(address ?? '');
  if (!family || extra !== undefined) {
    return `"${rule}" is not an IP address or CIDR range`;
  }
  if (prefix !== undefined) {
    const bits = Number(prefix);
    const max = family === 4 ? 32 : 128;
    if (!/^\d+$/.test(prefix) || bits < 0 || bits > max) {
      return `"${rule}" has an invalid prefix length`;
    }
  }
  return undefined;
}

function normalize(ip: string): string {
  // Node reports IPv4 clients on dual-stack sockets as ::ffff:1.2.3.4.
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/** An empty allowlist means "any IP". */
export function isIpAllowed(ip: string, rules: readonly string[]): boolean {
  if (rules.length === 0) {
    return true;
  }
  const address = normalize(ip);
  const family = isIP(address);
  if (!family) {
    return false;
  }
  const list = new BlockList();
  for (const rule of rules) {
    const [base, prefix] = rule.split('/');
    const ruleFamily = isIP(base!) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) {
      list.addAddress(base!, ruleFamily);
    } else {
      list.addSubnet(base!, Number(prefix), ruleFamily);
    }
  }
  return list.check(address, family === 6 ? 'ipv6' : 'ipv4');
}
