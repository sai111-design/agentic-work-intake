/**
 * SSRF protection tests.
 *
 * These verify the security boundary: no URL pointing at loopback, private,
 * link-local, or IPv6 internal addresses may pass through to a fetch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateUrlSync, validateRedirect } from '../tools/ssrf.js';

// ---------------------------------------------------------------------------
// MUST BE BLOCKED
// ---------------------------------------------------------------------------

const BLOCKED_URLS = [
  { url: 'http://localhost', reason: 'localhost' },
  { url: 'http://localhost:8080/admin', reason: 'localhost with port' },
  { url: 'http://127.0.0.1', reason: '127.0.0.1' },
  { url: 'http://127.0.0.1:3000', reason: '127.0.0.1 with port' },
  { url: 'http://127.1.2.3', reason: '127.x.x.x loopback range' },
  { url: 'http://10.0.0.1', reason: 'RFC 1918 10.x' },
  { url: 'http://10.255.255.255', reason: 'RFC 1918 10.x end' },
  { url: 'http://172.16.0.1', reason: 'RFC 1918 172.16.x' },
  { url: 'http://172.31.255.255', reason: 'RFC 1918 172.31.x end' },
  { url: 'http://192.168.0.1', reason: 'RFC 1918 192.168.x' },
  { url: 'http://192.168.1.100', reason: 'RFC 1918 192.168.x typical LAN' },
  { url: 'http://169.254.169.254', reason: 'link-local / cloud metadata' },
  { url: 'http://169.254.0.1', reason: 'link-local range' },
  { url: 'http://0.0.0.0', reason: 'current network' },
  { url: 'http://[::1]', reason: 'IPv6 loopback' },
  { url: 'http://[::ffff:127.0.0.1]', reason: 'IPv4-mapped IPv6 loopback' },
  { url: 'ftp://example.com', reason: 'FTP scheme' },
  { url: 'file:///etc/passwd', reason: 'file scheme' },
  { url: 'javascript:alert(1)', reason: 'javascript scheme' },
  { url: 'data:text/html,<h1>Hi</h1>', reason: 'data scheme' },
  { url: 'not-a-url', reason: 'invalid URL' },
  { url: '', reason: 'empty string' },
  { url: 'http://metadata.google.internal/computeMetadata', reason: 'GCP metadata' },
];

for (const { url, reason } of BLOCKED_URLS) {
  test(`SSRF blocks: ${reason} (${url})`, () => {
    const result = validateUrlSync(url);
    assert.equal(result.safe, false, `Expected ${url} to be blocked`);
  });
}

// ---------------------------------------------------------------------------
// MUST BE ALLOWED
// ---------------------------------------------------------------------------

const ALLOWED_URLS = [
  'https://example.com',
  'https://hedamo.com',
  'http://example.com',
  'https://www.google.com/search?q=test',
  'https://93.184.216.34',  // example.com's public IP
];

for (const url of ALLOWED_URLS) {
  test(`SSRF allows: ${url}`, () => {
    const result = validateUrlSync(url);
    assert.equal(result.safe, true, `Expected ${url} to be allowed, got: ${!result.safe ? (result as { reason: string }).reason : ''}`);
  });
}

// ---------------------------------------------------------------------------
// REDIRECT VALIDATION
// ---------------------------------------------------------------------------

test('redirect to localhost is blocked', () => {
  const result = validateRedirect('http://localhost/admin');
  assert.equal(result.safe, false);
});

test('redirect to private IP is blocked', () => {
  const result = validateRedirect('http://192.168.1.1/');
  assert.equal(result.safe, false);
});

test('redirect to public URL is allowed', () => {
  const result = validateRedirect('https://www.example.com/');
  assert.equal(result.safe, true);
});

test('redirect to file:// is blocked', () => {
  const result = validateRedirect('file:///etc/shadow');
  assert.equal(result.safe, false);
});
