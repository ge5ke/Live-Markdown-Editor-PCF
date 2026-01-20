/**
 * Security Utilities
 * URL validation, HTML sanitization, and input validation functions
 */

import DOMPurify from 'dompurify';
import {
    DANGEROUS_PROTOCOLS,
    SAFE_LINK_PROTOCOLS,
    SAFE_IMAGE_PROTOCOLS,
    MAX_IMAGE_SIZE_BYTES,
    MAX_IMAGE_SIZE_MB,
    MAX_FILENAME_LENGTH,
    RESERVED_FILENAMES,
    INVALID_FILENAME_CHARS
} from './constants';

export interface ValidationResult {
    valid: boolean;
    error?: string;
    sanitized?: string;
}

/**
 * Validates a URL for use in links
 * Blocks dangerous protocols like javascript:, vbscript:, data:text/html
 * Allows http, https, mailto, tel, ftp, and relative URLs
 */
export function validateLinkUrl(url: string): ValidationResult {
    if (!url || typeof url !== 'string') {
        return { valid: false, error: 'URL is required' };
    }

    const trimmedUrl = url.trim();
    if (trimmedUrl === '') {
        return { valid: false, error: 'URL cannot be empty' };
    }

    // Check for dangerous protocols (case-insensitive)
    const lowerUrl = trimmedUrl.toLowerCase();
    for (const protocol of DANGEROUS_PROTOCOLS) {
        if (lowerUrl.startsWith(protocol)) {
            return {
                valid: false,
                error: `Dangerous protocol "${protocol.replace(':', '')}" is not allowed`
            };
        }
    }

    // Allow relative URLs (starting with /, #, or no protocol)
    if (trimmedUrl.startsWith('/') || trimmedUrl.startsWith('#') || trimmedUrl.startsWith('.')) {
        return { valid: true, sanitized: trimmedUrl };
    }

    // Check if URL has a protocol
    const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl);

    if (hasProtocol) {
        // Validate against allowed protocols
        const isSafe = SAFE_LINK_PROTOCOLS.some(protocol =>
            lowerUrl.startsWith(protocol)
        );

        if (!isSafe) {
            return {
                valid: false,
                error: 'URL protocol is not allowed. Use http, https, mailto, tel, or ftp.'
            };
        }
    }

    // URL is valid (either has safe protocol or is protocol-relative/no-protocol)
    return { valid: true, sanitized: trimmedUrl };
}

/**
 * Validates a URL for use in images
 * Allows http, https, and data:image/ URLs (for pasted images)
 * Blocks all other protocols
 */
export function validateImageUrl(url: string): ValidationResult {
    if (!url || typeof url !== 'string') {
        return { valid: false, error: 'Image URL is required' };
    }

    const trimmedUrl = url.trim();
    if (trimmedUrl === '') {
        return { valid: false, error: 'Image URL cannot be empty' };
    }

    // Check for dangerous protocols (case-insensitive)
    const lowerUrl = trimmedUrl.toLowerCase();
    for (const protocol of DANGEROUS_PROTOCOLS) {
        if (lowerUrl.startsWith(protocol)) {
            return {
                valid: false,
                error: `Dangerous protocol "${protocol.replace(':', '')}" is not allowed`
            };
        }
    }

    // Allow relative URLs
    if (trimmedUrl.startsWith('/') || trimmedUrl.startsWith('.')) {
        return { valid: true, sanitized: trimmedUrl };
    }

    // Check if URL has a protocol
    const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl);

    if (hasProtocol) {
        // Validate against allowed protocols for images
        const isSafe = SAFE_IMAGE_PROTOCOLS.some(protocol =>
            lowerUrl.startsWith(protocol)
        );

        if (!isSafe) {
            return {
                valid: false,
                error: 'Image URL protocol is not allowed. Use http, https, or data:image/.'
            };
        }
    }

    return { valid: true, sanitized: trimmedUrl };
}

/**
 * Validates and sanitizes a filename
 * Enforces length limits, removes invalid characters, handles reserved names
 */
export function validateFilename(filename: string): ValidationResult {
    if (!filename || typeof filename !== 'string') {
        return { valid: false, error: 'Filename is required', sanitized: 'document' };
    }

    let sanitized = filename.trim();

    if (sanitized === '') {
        return { valid: true, sanitized: 'document' };
    }

    // Remove invalid characters
    sanitized = sanitized.replace(INVALID_FILENAME_CHARS, '_');

    // Remove leading/trailing dots and spaces
    sanitized = sanitized.replace(/^[.\s]+|[.\s]+$/g, '');

    // Check for reserved names (Windows)
    const nameWithoutExt = sanitized.split('.')[0].toUpperCase();
    if (RESERVED_FILENAMES.includes(nameWithoutExt)) {
        sanitized = '_' + sanitized;
    }

    // Enforce length limit
    if (sanitized.length > MAX_FILENAME_LENGTH) {
        sanitized = sanitized.substring(0, MAX_FILENAME_LENGTH);
    }

    // Default to 'document' if empty after sanitization
    if (sanitized === '') {
        sanitized = 'document';
    }

    return { valid: true, sanitized };
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

/**
 * Sanitizes HTML content using DOMPurify
 * Removes scripts, event handlers, and other potentially dangerous content
 */
export function sanitizeHtml(html: string): string {
    if (!html || typeof html !== 'string') {
        return '';
    }

    // Configure DOMPurify to allow safe HTML elements
    const clean = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'p', 'br', 'hr',
            'ul', 'ol', 'li',
            'table', 'thead', 'tbody', 'tr', 'th', 'td',
            'blockquote', 'pre', 'code',
            'strong', 'em', 'del', 'u', 's',
            'a', 'img',
            'div', 'span',
            'input' // For checkboxes in task lists
        ],
        ALLOWED_ATTR: [
            'href', 'src', 'alt', 'title',
            'class', 'id',
            'type', 'checked', 'disabled', // For checkboxes
            'colspan', 'rowspan', // For tables
            'target', 'rel' // For links
        ],
        ALLOW_DATA_ATTR: false,
        ADD_ATTR: ['target'], // Add target="_blank" capability
        FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'object', 'embed'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus']
    });

    return clean;
}

/**
 * Escapes HTML special characters for safe display
 * Use for inserting user content into HTML contexts
 */
export function escapeHtml(text: string): string {
    if (!text || typeof text !== 'string') {
        return '';
    }

    const escapeMap: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };

    return text.replace(/[&<>"']/g, char => escapeMap[char]);
}

/**
 * Creates a safe filename from user input
 * Convenience function combining validation and sanitization
 */
export function createSafeFilename(filename: string, defaultName = 'document'): string {
    const result = validateFilename(filename);
    return result.sanitized || defaultName;
}
