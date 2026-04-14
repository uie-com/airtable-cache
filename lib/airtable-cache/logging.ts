// This module creates the small logging adapter used by the cache service.
// It keeps log messages consistent by adding a scope prefix and only attaching
// extra context when there is actually something useful to print.
import { Logger } from "@/lib/airtable-cache/types";

// Build the exact message string that will be sent to `console`.
// The scope is put in square brackets so every line can be traced back to the
// part of the service that wrote it.
function formatMessage(scope: string, message: string): string {
  return `[${scope}] ${message}`;
}

// Decide whether there is any context data worth passing to `console`.
// An empty object should behave like no context at all, because that keeps the
// log output clean and avoids printing noise that does not help debugging.
function hasContext(context?: Record<string, unknown>): boolean {
  return Boolean(context && Object.keys(context).length > 0);
}

// Create a logger that writes to the built-in console with a fixed scope label.
// Callers use this so they do not have to repeat the formatting rules every
// time they want to write an info, warning, or error message.
export function createLogger(scope: string): Logger {
  return {
    info(message, context) {
      if (hasContext(context)) {
        console.info(formatMessage(scope, message), context);
        return;
      }

      console.info(formatMessage(scope, message));
    },
    warn(message, context) {
      if (hasContext(context)) {
        console.warn(formatMessage(scope, message), context);
        return;
      }

      console.warn(formatMessage(scope, message));
    },
    error(message, context) {
      if (hasContext(context)) {
        console.error(formatMessage(scope, message), context);
        return;
      }

      console.error(formatMessage(scope, message));
    },
  };
}
