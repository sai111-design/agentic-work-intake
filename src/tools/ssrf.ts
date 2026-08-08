/**
 * SSRF defence for any outbound HTTP capability.
 *
 * The website-check tool is the only outbound network tool in the system.
 * Before it touches a URL, this module validates:
 *   - scheme (only http/https)
 *   - hostname (no loopback, private, link-local, or metadata IPs)
 *   - resolved IP (prevents DNS rebinding and redirect-to-internal attacks)
 *
 * This is a security boundary. Every change must be accompanied by a test.
 */

import { lookup } from 'node:dns/promises';

/** Schemes the system will ever request. Everything else is blocked. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Known-dangerous hostnames. Checked before DNS to catch the obvious cases
 * quickly and to protect against DNS resolution that returns non-routable IPs.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '127.0.0.1',
  '[::1]',
  '0.0.0.0',
  '[::0]',
  '[::ffff:127.0.0.1]',
  'metadata.google.internal',
  '169.254.169.254',
]);

/**
 * Check whether an IPv4 address is in a private/reserved range.
 * Returns a human-readable reason, or null if the address is safe.
 */
function privateIpv4Reason(ip: string): string | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return null;
  const [a, b] = parts as [number, number, number, number];

  if (a === 10) return 'RFC 1918 private (10.0.0.0/8)';
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return 'RFC 1918 private (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'RFC 1918 private (192.168.0.0/16)';
  if (a === 127) return 'loopback (127.0.0.0/8)';
  if (a === 169 && b === 254) return 'link-local (169.254.0.0/16)';
  if (a === 0) return 'current network (0.0.0.0/8)';
  return null;
}

/**
 * Check whether an IPv6 address is loopback, link-local, or unique-local.
 * Works on the normalised forms Node's dns module returns.
 */
function privateIpv6Reason(ip: string): string | null {
  const clean = ip.replace(/^\[|]$/g, '').toLowerCase();
  if (clean === '::1') return 'IPv6 loopback';
  if (clean === '::' || clean === '::0') return 'IPv6 unspecified';
  if (clean.startsWith('fe80')) return 'IPv6 link-local';
  if (clean.startsWith('fc') || clean.startsWith('fd')) return 'IPv6 unique-local';
  // IPv4-mapped IPv6 in dotted-decimal form: ::ffff:127.0.0.1
  const v4mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped?.[1]) return privateIpv4Reason(v4mapped[1]);
  // IPv4-mapped IPv6 in hex form: ::ffff:7f00:1 (Node's URL parser normalizes to this)
  const v4hex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4hex?.[1] && v4hex[2]) {
    const hi = parseInt(v4hex[1], 16);
    const lo = parseInt(v4hex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return privateIpv4Reason(dotted);
  }
  return null;
}

export type SsrfCheck =
  | { safe: true }
  | { safe: false; reason: string };

/**
 * Validate a URL string against all SSRF rules BEFORE making any request.
 * Returns synchronously for syntactic/hostname checks; async for DNS.
 */
export function validateUrlSync(raw: string): SsrfCheck {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { safe: false, reason: 'Not a valid URL.' };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { safe: false, reason: `Scheme "${parsed.protocol}" is not allowed. Only http/https are permitted.` };
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { safe: false, reason: `Hostname "${host}" is blocked (loopback or reserved).` };
  }

  // Bare IPv4 in the hostname
  const ipv4reason = privateIpv4Reason(host);
  if (ipv4reason) {
    return { safe: false, reason: `IP address ${host} is blocked: ${ipv4reason}.` };
  }

  // Bare IPv6 in the hostname (URL class strips the brackets into .hostname)
  const ipv6reason = privateIpv6Reason(host);
  if (ipv6reason) {
    return { safe: false, reason: `IP address ${host} is blocked: ${ipv6reason}.` };
  }

  return { safe: true };
}

/**
 * Full validation including DNS resolution. Call this before every fetch.
 *
 * This catches DNS rebinding: a hostname that syntactically looks fine but
 * resolves to a private IP.
 */
export async function validateUrl(raw: string): Promise<SsrfCheck> {
  const sync = validateUrlSync(raw);
  if (!sync.safe) return sync;

  const parsed = new URL(raw);
  const host = parsed.hostname;

  // If the hostname is already a bare IP, skip DNS — we checked it above.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { safe: true };

  try {
    const result = await lookup(host, { all: true });
    for (const entry of result) {
      const reason =
        entry.family === 4
          ? privateIpv4Reason(entry.address)
          : privateIpv6Reason(entry.address);
      if (reason) {
        return {
          safe: false,
          reason: `Hostname "${host}" resolves to ${entry.address}, which is blocked: ${reason}.`,
        };
      }
    }
  } catch {
    // DNS failure — we'll let the actual fetch fail with a clear error
    // rather than blocking here, since the host might be legitimate but
    // temporarily unresolvable.
  }

  return { safe: true };
}

/**
 * Validate a redirect destination. Called after every redirect to prevent
 * open-redirect SSRF.
 */
export function validateRedirect(redirectUrl: string): SsrfCheck {
  return validateUrlSync(redirectUrl);
}
