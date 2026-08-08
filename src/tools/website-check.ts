/**
 * Tool 3 — Website Check
 *
 * Bounded, deterministic HTTP check of a website. Returns ONLY evidence
 * actually collected — never fabricates accessibility, security, SEO,
 * performance, or browser-automation checks.
 *
 * What it actually does:
 *   - SSRF validation (scheme, hostname, resolved IP, redirect destinations)
 *   - HTTP GET with redirect following (up to 5, each validated)
 *   - Captures: final URL, status, content-type, response time
 *   - Parses HTML for <title> and basic meta tags
 *   - Enforces response size limit (1 MB)
 *   - Enforces timeout (10 seconds)
 *
 * What it does NOT do (and must never claim):
 *   - JavaScript execution
 *   - Accessibility testing
 *   - Visual regression
 *   - Security scanning
 *   - SEO auditing
 *   - Performance lab metrics
 */

import { validateUrl, validateRedirect } from './ssrf.js';
import type { ToolResult } from './registry.js';

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_024 * 1_024; // 1 MB
const MAX_REDIRECTS = 5;

interface CheckEvidence {
  requested_url: string;
  final_url: string;
  http_status: number;
  status_text: string;
  content_type: string | null;
  response_time_ms: number;
  page_title: string | null;
  meta_description: string | null;
  meta_viewport: string | null;
  html_lang: string | null;
  has_doctype: boolean;
  content_length_bytes: number;
  redirect_count: number;
  checks_performed: string[];
  error: string | null;
}

/** Extract <title> text from HTML. Simple regex — no DOM parser needed. */
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.trim().replace(/\s+/g, ' ') ?? null;
}

/** Extract a meta tag's content attribute. */
function extractMeta(html: string, name: string): string | null {
  // matches <meta name="description" content="..."> in either order
  const pattern = new RegExp(
    `<meta[^>]*(?:name=["']${name}["'][^>]*content=["']([^"']*)["']|content=["']([^"']*)["'][^>]*name=["']${name}["'])`,
    'i',
  );
  const match = html.match(pattern);
  return match?.[1] ?? match?.[2] ?? null;
}

/** Extract the lang attribute from <html>. */
function extractHtmlLang(html: string): string | null {
  const match = html.match(/<html[^>]*\slang=["']([^"']*)["']/i);
  return match?.[1] ?? null;
}

export async function websiteCheck(input: Record<string, unknown>): Promise<ToolResult> {
  const url = String(input['url'] ?? '').trim();
  if (!url) {
    return { ok: false, summary: 'No URL provided.', data: { error: 'missing_url' } };
  }

  // SSRF validation (async — includes DNS resolution check)
  const ssrfCheck = await validateUrl(url);
  if (!ssrfCheck.safe) {
    return {
      ok: false,
      summary: `URL blocked by security policy: ${ssrfCheck.reason}`,
      data: { error: 'ssrf_blocked', reason: ssrfCheck.reason, requested_url: url },
    };
  }

  const checksPerformed: string[] = [
    'URL validation',
    'SSRF protection',
    'HTTP GET request',
    'Status code check',
    'Content-type check',
    'Response time measurement',
  ];

  const startTime = Date.now();
  let response: Response;
  let redirectCount = 0;

  try {
    // Manual redirect handling so we can validate each redirect destination
    let currentUrl = url;
    let finalResponse: Response | null = null;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const resp = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'User-Agent': 'AgenticWorkIntake-WebsiteCheck/1.0',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
      });

      // Check if this is a redirect
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) {
          finalResponse = resp;
          break;
        }

        // Resolve relative redirects
        const redirectTarget = new URL(location, currentUrl).href;
        const redirectCheck = validateRedirect(redirectTarget);
        if (!redirectCheck.safe) {
          return {
            ok: false,
            summary: `Redirect to ${redirectTarget} blocked by security policy: ${redirectCheck.reason}`,
            data: {
              error: 'ssrf_redirect_blocked',
              reason: redirectCheck.reason,
              requested_url: url,
              redirect_target: redirectTarget,
            },
          };
        }

        redirectCount++;
        currentUrl = redirectTarget;
        continue;
      }

      finalResponse = resp;
      break;
    }

    if (!finalResponse) {
      return {
        ok: false,
        summary: `Too many redirects (>${MAX_REDIRECTS}).`,
        data: { error: 'too_many_redirects', requested_url: url },
      };
    }

    response = finalResponse;
  } catch (err) {
    const responseTime = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

    return {
      ok: false,
      summary: isTimeout
        ? `Website check timed out after ${TIMEOUT_MS}ms`
        : `Website check failed: ${message}`,
      data: {
        requested_url: url,
        error: isTimeout ? 'timeout' : 'fetch_failed',
        message,
        response_time_ms: responseTime,
        checks_performed: checksPerformed,
      } as Record<string, unknown>,
    };
  }

  const responseTime = Date.now() - startTime;
  const contentType = response.headers.get('content-type');
  const isHtml = contentType?.includes('text/html') ?? false;

  // Read body with size limit
  let bodyText = '';
  let contentLength = 0;
  try {
    const buffer = await response.arrayBuffer();
    contentLength = buffer.byteLength;
    if (contentLength > MAX_RESPONSE_BYTES) {
      bodyText = new TextDecoder().decode(buffer.slice(0, MAX_RESPONSE_BYTES));
    } else {
      bodyText = new TextDecoder().decode(buffer);
    }
  } catch {
    // Body read failure — we still have the status code and headers
  }

  let pageTitle: string | null = null;
  let metaDescription: string | null = null;
  let metaViewport: string | null = null;
  let htmlLang: string | null = null;
  let hasDoctype = false;

  if (isHtml && bodyText) {
    checksPerformed.push('HTML title extraction', 'Meta tag extraction', 'DOCTYPE check', 'HTML lang check');
    pageTitle = extractTitle(bodyText);
    metaDescription = extractMeta(bodyText, 'description');
    metaViewport = extractMeta(bodyText, 'viewport');
    htmlLang = extractHtmlLang(bodyText);
    hasDoctype = /^\s*<!doctype\s/i.test(bodyText);
  }

  const evidence: CheckEvidence = {
    requested_url: url,
    final_url: response.url || url,
    http_status: response.status,
    status_text: response.statusText,
    content_type: contentType,
    response_time_ms: responseTime,
    page_title: pageTitle,
    meta_description: metaDescription,
    meta_viewport: metaViewport,
    html_lang: htmlLang,
    has_doctype: hasDoctype,
    content_length_bytes: contentLength,
    redirect_count: redirectCount,
    checks_performed: checksPerformed,
    error: null,
  };

  const statusOk = response.status >= 200 && response.status < 400;

  return {
    ok: statusOk,
    summary: statusOk
      ? `Website check passed: HTTP ${response.status}, "${pageTitle ?? '(no title)'}", ${responseTime}ms`
      : `Website returned HTTP ${response.status} (${response.statusText})`,
    data: evidence as unknown as Record<string, unknown>,
  };
}
