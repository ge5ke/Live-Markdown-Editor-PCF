/**
 * Security Utilities
 * URL validation, HTML sanitization, and input validation functions
 */

import {
    SAFE_LINK_PROTOCOLS,
    SAFE_IMAGE_PROTOCOLS,
    MAX_IMAGE_SIZE_BYTES,
    MAX_IMAGE_SIZE_MB
} from './constants';

export interface ValidationResult {
    valid: boolean;
    error?: string;
    sanitized?: string;
}

// Used only as a base for the WHATWG URL parser to classify a candidate that has no scheme of
// its own (e.g. "/path", "#frag", "./thing") as relative - never used as a real network origin,
// and never leaks into a returned value.
const RELATIVE_URL_BASE = 'https://placeholder.invalid';

// ASCII control characters (0x00-0x1F, 0x7F) plus the whitespace characters browsers silently
// strip from a URL before navigating to it. Stripping these BEFORE classification/parsing is
// what closes the bypass: a naive substring check like url.startsWith('javascript:') is easily
// defeated by an embedded control character the browser removes later but the check never saw.
//
// Attack shapes this closes:
//   - "java\tscript:alert(1)"  - tab (0x09) splits the scheme keyword past a naive prefix check;
//                                stripped first, it re-forms as "javascript:alert(1)" and is
//                                correctly rejected by the protocol allowlist below.
//   - "javascript:alert(1)"    - plain dangerous protocol, rejected directly.
//   - "JavaScript:Alert(1)"    - mixed-case protocol; the URL parser lowercases the scheme it
//                                extracts, so this rejects the same as the lowercase form.
//   - "//evil.example/x"       - protocol-relative. This has no scheme of its own, so it fails
//                                the no-base parse and is classified via the placeholder-base
//                                fallback as relative; structurally a protocol-relative URL can
//                                only ever inherit a real network scheme (http/https) from
//                                whatever page it is used on, never javascript:, so treating it
//                                as relative-and-safe here is correct.
// eslint-disable-next-line no-control-regex -- matching control characters is the intent here
const CONTROL_AND_WHITESPACE_REGEX = /[\x00-\x20\x7F]/g;

interface ParsedCandidate {
    parsed: URL;
    // True when the candidate had no scheme of its own and only parsed successfully against the
    // placeholder base above - i.e. it is relative to whatever document it ends up in.
    isRelative: boolean;
}

// Strips control/whitespace chars, then classifies the result as either an absolute URL (real
// scheme) or relative (only resolves against a base). Returns null when the candidate is not a
// usable URL at all (neither absolute nor resolvable as relative).
function parseUrlCandidate(candidate: string): ParsedCandidate | null {
    try {
        return { parsed: new URL(candidate), isRelative: false };
    } catch {
        try {
            return { parsed: new URL(candidate, RELATIVE_URL_BASE), isRelative: true };
        } catch {
            return null;
        }
    }
}

/**
 * Validates a URL for use in links.
 * Allows http, https, mailto, tel, ftp (SAFE_LINK_PROTOCOLS) and relative URLs.
 * See CONTROL_AND_WHITESPACE_REGEX above for the attack shapes this specifically closes.
 */
export function validateLinkUrl(url: string): ValidationResult {
    if (!url || typeof url !== 'string') {
        return { valid: false, error: 'URL is required' };
    }

    const trimmed = url.trim();
    if (trimmed === '') {
        return { valid: false, error: 'URL cannot be empty' };
    }

    // Candidate is the value actually classified AND returned as `sanitized` - never the raw
    // (control-char-containing) input.
    const candidate = trimmed.replace(CONTROL_AND_WHITESPACE_REGEX, '');
    if (candidate === '') {
        return { valid: false, error: 'URL cannot be empty' };
    }

    const result = parseUrlCandidate(candidate);
    if (!result) {
        return { valid: false, error: 'URL is not valid' };
    }

    if (result.isRelative) {
        return { valid: true, sanitized: candidate };
    }

    if (!SAFE_LINK_PROTOCOLS.includes(result.parsed.protocol)) {
        return {
            valid: false,
            error: 'URL protocol is not allowed. Use http, https, mailto, tel, or ftp.'
        };
    }

    return { valid: true, sanitized: candidate };
}

/**
 * Validates a URL for use in images.
 * Allows http, https, relative URLs, and data: URLs ONLY when the full (stripped) href starts
 * with "data:image/" - e.g. data:text/html is rejected even though its protocol is "data:".
 */
export function validateImageUrl(url: string): ValidationResult {
    if (!url || typeof url !== 'string') {
        return { valid: false, error: 'Image URL is required' };
    }

    const trimmed = url.trim();
    if (trimmed === '') {
        return { valid: false, error: 'Image URL cannot be empty' };
    }

    const candidate = trimmed.replace(CONTROL_AND_WHITESPACE_REGEX, '');
    if (candidate === '') {
        return { valid: false, error: 'Image URL cannot be empty' };
    }

    const result = parseUrlCandidate(candidate);
    if (!result) {
        return { valid: false, error: 'Image URL is not valid' };
    }

    if (result.isRelative) {
        return { valid: true, sanitized: candidate };
    }

    const { protocol } = result.parsed;
    const lowerCandidate = candidate.toLowerCase();

    const isSafe = SAFE_IMAGE_PROTOCOLS.some((safeProtocol) =>
        safeProtocol.startsWith('data:')
            ? protocol === 'data:' && lowerCandidate.startsWith(safeProtocol)
            : protocol === safeProtocol
    );

    if (!isSafe) {
        return {
            valid: false,
            error: 'Image URL protocol is not allowed. Use http, https, or data:image/.'
        };
    }

    return { valid: true, sanitized: candidate };
}

/**
 * Validates an image file size
 * Enforces maximum size limit (default 5MB)
 */
export function validateImageSize(file: File | null, maxBytes: number = MAX_IMAGE_SIZE_BYTES): ValidationResult {
    if (!file) {
        return { valid: false, error: 'No file provided' };
    }

    if (file.size > maxBytes) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
        return {
            valid: false,
            error: `Image is too large (${sizeMB}MB). Maximum size is ${MAX_IMAGE_SIZE_MB}MB.`
        };
    }

    return { valid: true };
}
