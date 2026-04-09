/**
 * Application Constants
 * Extracted magic numbers and configuration values
 */

// Timing constants
export const DEBOUNCE_SERIALIZE_MS = 150;   // Typing debounce for serialization
export const DEBOUNCE_SEARCH_MS = 100;      // Find & replace debounce
export const COPY_SUCCESS_TIMEOUT_MS = 2000; // Copy success indicator duration

// Size limits
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB image paste limit
export const MAX_IMAGE_SIZE_MB = 5;
export const MAX_FILENAME_LENGTH = 255;
export const MAX_MARKDOWN_LENGTH = 100000;

// Table constants
export const TABLE_GRID_SIZE = 6;           // 6x6 table picker grid
export const TABLE_MIN_ROWS = 2;            // Minimum rows (header + 1 data row)
export const TABLE_MIN_COLS = 1;            // Minimum columns

// Windows reserved filenames (case-insensitive)
export const RESERVED_FILENAMES = [
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
];

// Characters not allowed in filenames (Windows + common restrictions)
// eslint-disable-next-line no-control-regex
export const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

// Dangerous URL protocols to block
export const DANGEROUS_PROTOCOLS = [
    'javascript:',
    'vbscript:',
    'data:text/html',
    'data:application'
];

// Safe protocols for links
export const SAFE_LINK_PROTOCOLS = [
    'http:',
    'https:',
    'mailto:',
    'tel:',
    'ftp:'
];

// Safe protocols for images (includes data: for pasted images)
export const SAFE_IMAGE_PROTOCOLS = [
    'http:',
    'https:',
    'data:image/'  // Allow data URLs for images only
];
