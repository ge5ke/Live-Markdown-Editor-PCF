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

export type ErrorCallback = (error: Error, context: ErrorContext, severity: ErrorSeverity) => void;

// Private state
let errorCallback: ErrorCallback | null = null;
const isDevelopment = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

/**
 * Set a custom error callback for handling errors
 * Useful for displaying notifications to users
 */
export function setErrorCallback(callback: ErrorCallback | null): void {
    errorCallback = callback;
}

/**
 * Get the current error callback
 */
export function getErrorCallback(): ErrorCallback | null {
    return errorCallback;
}

/**
 * Handle an error with consistent logging and notification
 * - In development: logs to console
 * - In production: silent (no console output)
 * - Always calls error callback if set
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

    // Call custom callback if set
    if (errorCallback) {
        try {
            errorCallback(normalizedError, context, severity);
        } catch {
            // Prevent callback errors from propagating
        }
    }
}

/**
 * Create a scoped error handler for a specific component
 * Returns a function that automatically includes the component name
 */
export function createScopedHandler(component: string): (
    error: unknown,
    action?: string,
    severity?: ErrorSeverity,
    details?: Record<string, unknown>
) => void {
    return (
        error: unknown,
        action?: string,
        severity: ErrorSeverity = 'error',
        details?: Record<string, unknown>
    ) => {
        handleError(error, { component, action, details }, severity);
    };
}

/**
 * Wrap an async function with error handling
 * Returns a function that catches and handles errors automatically
 */
export function withErrorHandling<T extends unknown[], R>(
    fn: (...args: T) => Promise<R>,
    context: ErrorContext = {}
): (...args: T) => Promise<R | undefined> {
    return async (...args: T): Promise<R | undefined> => {
        try {
            return await fn(...args);
        } catch (error) {
            handleError(error, context);
            return undefined;
        }
    };
}

/**
 * Wrap a sync function with error handling
 * Returns a function that catches and handles errors automatically
 */
export function withSyncErrorHandling<T extends unknown[], R>(
    fn: (...args: T) => R,
    context: ErrorContext = {}
): (...args: T) => R | undefined {
    return (...args: T): R | undefined => {
        try {
            return fn(...args);
        } catch (error) {
            handleError(error, context);
            return undefined;
        }
    };
}

/**
 * Try to execute a function and return a default value on error
 */
export function tryOrDefault<T>(
    fn: () => T,
    defaultValue: T,
    context?: ErrorContext
): T {
    try {
        return fn();
    } catch (error) {
        if (context) {
            handleError(error, context, 'warning');
        }
        return defaultValue;
    }
}
