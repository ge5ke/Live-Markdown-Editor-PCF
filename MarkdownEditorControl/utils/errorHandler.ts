/**
 * Centralized Error Handler
 * Provides consistent error handling across the application
 */

export type ErrorSeverity = 'info' | 'warning' | 'error';

export interface ErrorContext {
    component?: string;
    action?: string;
    details?: Record<string, unknown>;
}

const isDevelopment = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

/**
 * Handle an error with consistent logging
 * - In development: logs to console
 * - In production: silent (no console output)
 */
export function handleError(
    error: unknown,
    context: ErrorContext = {},
    severity: ErrorSeverity = 'error'
): void {
    // Normalize error to Error object
    const normalizedError = error instanceof Error
        ? error
        : new Error(String(error));

    // Log in development mode only
    if (isDevelopment) {
        const contextStr = context.component
            ? `[${context.component}${context.action ? ':' + context.action : ''}]`
            : '';

        switch (severity) {
            case 'info':
                console.info(`${contextStr}`, normalizedError.message, context.details || '');
                break;
            case 'warning':
                console.warn(`${contextStr}`, normalizedError.message, context.details || '');
                break;
            case 'error':
                console.error(`${contextStr}`, normalizedError.message, context.details || '');
                break;
        }
    }
}
