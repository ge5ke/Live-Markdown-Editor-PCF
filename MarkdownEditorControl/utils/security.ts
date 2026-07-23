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

// Only the whitespace characters browsers silently strip from *anywhere* in a URL before
// navigating to it: tab, LF, CR. (Leading/trailing whitespace of any kind, including plain
// spaces, is handled separately by .trim() below - browsers strip that too, but only at the
// ends.) Stripping these BEFORE classification/parsing is what closes the scheme-splitting
// bypass: a naive substring check like url.startsWith('javascript:') is easily defeated by an
// embedded tab/newline/CR the browser removes later but the check never saw.
//
// Deliberately narrower than "all of 0x00-0x1F, 0x7F": an *interior* plain space or other
// control character is not silently stripped by browsers the way tab/LF/CR are, so silently
// stripping it here would silently alter an otherwise-legitimate URL (e.g. a data: URL or a
// path segment that intentionally contains one) rather than matching real browser behavior.
// Those are handled below instead: interior control characters other than tab/LF/CR make the
// candidate invalid and the URL is rejected outright, never silently rewritten.
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
const STRIPPED_WHITESPACE_REGEX = /[\t\n\r]/g;

// Any remaining ASCII control character (0x00-0x1F minus tab/LF/CR, plus 0x7F/DEL) after the
// strip above is treated as an invalid URL rather than silently removed - see
// STRIPPED_WHITESPACE_REGEX's comment for why silent stripping is wrong for these.
// eslint-disable-next-line no-control-regex -- matching control characters is the intent here
const INTERIOR_CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

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
 * See STRIPPED_WHITESPACE_REGEX above for the attack shapes this specifically closes.
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
    // (tab/newline/CR-containing) input. Interior plain spaces are deliberately left as-is here -
    // see STRIPPED_WHITESPACE_REGEX's comment.
    const candidate = trimmed.replace(STRIPPED_WHITESPACE_REGEX, '');
    if (candidate === '') {
        return { valid: false, error: 'URL cannot be empty' };
    }

    // Any other interior control character is rejected outright rather than silently stripped -
    // see INTERIOR_CONTROL_CHAR_REGEX's comment.
    if (INTERIOR_CONTROL_CHAR_REGEX.test(candidate)) {
        return { valid: false, error: 'URL contains invalid control characters' };
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
 * Note: data:image/svg+xml URLs can embed <script>, but that is deliberately accepted here -
 * the value only ever lands in an <img> src context, where browsers do not execute scripts
 * inside SVG image documents.
 */
export function validateImageUrl(url: string): ValidationResult {
    if (!url || typeof url !== 'string') {
        return { valid: false, error: 'Image URL is required' };
    }

    const trimmed = url.trim();
    if (trimmed === '') {
        return { valid: false, error: 'Image URL cannot be empty' };
    }

    // See validateLinkUrl above for why only tab/LF/CR are stripped here (interior plain spaces
    // are left as-is) and why remaining interior control characters are rejected, not stripped.
    const candidate = trimmed.replace(STRIPPED_WHITESPACE_REGEX, '');
    if (candidate === '') {
        return { valid: false, error: 'Image URL cannot be empty' };
    }

    if (INTERIOR_CONTROL_CHAR_REGEX.test(candidate)) {
        return { valid: false, error: 'Image URL contains invalid control characters' };
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
