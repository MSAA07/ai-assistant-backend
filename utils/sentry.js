import * as Sentry from "@sentry/node";

const PROCESS_HANDLER_INTEGRATIONS = new Set([
  "OnUncaughtException",
  "OnUnhandledRejection",
]);

let sentryInitialized = false;

export function getErrorStatusCode(error) {
  const statusCode = error?.status
    ?? error?.statusCode
    ?? error?.status_code
    ?? error?.output?.statusCode;

  const parsedStatusCode = Number.parseInt(statusCode, 10);
  return Number.isInteger(parsedStatusCode) ? parsedStatusCode : 500;
}

export function isExpectedGuardrailError(error) {
  return error?.code === "doc_cap_hit" || error?.code === "token_cap_hit";
}

export function shouldReportErrorToSentry(error) {
  return !isExpectedGuardrailError(error);
}

export function normalizeError(error) {
  if (error instanceof Error) {
    return error;
  }

  if (error && typeof error === "object") {
    const normalizedError = new Error(error.message || "Non-Error exception captured");
    Object.assign(normalizedError, error);
    return normalizedError;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  return new Error("Non-Error exception captured");
}

function getSentryEnvironment() {
  return process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";
}

export function initSentry({
  serviceName = "backend",
  disableProcessHandlers = false,
} = {}) {
  const dsn = process.env.SENTRY_DSN?.trim();

  if (!dsn) {
    console.log(`[sentry] disabled for ${serviceName}`);
    return false;
  }

  let defaultIntegrations = Sentry.getDefaultIntegrationsWithoutPerformance();

  if (disableProcessHandlers) {
    defaultIntegrations = defaultIntegrations.filter(
      (integration) => !PROCESS_HANDLER_INTEGRATIONS.has(integration.name),
    );
  }

  Sentry.init({
    dsn,
    environment: getSentryEnvironment(),
    defaultIntegrations,
    beforeSend(event, hint) {
      if (hint?.originalException && !shouldReportErrorToSentry(hint.originalException)) {
        return null;
      }

      return event;
    },
    initialScope: {
      tags: {
        service: serviceName,
      },
    },
  });

  sentryInitialized = true;
  console.log(`[sentry] enabled for ${serviceName} env=${getSentryEnvironment()}`);
  return true;
}

export function setupSentryExpressErrorHandler(app) {
  if (!sentryInitialized) {
    return;
  }

  Sentry.setupExpressErrorHandler(app, {
    shouldHandleError(error) {
      return shouldReportErrorToSentry(error) && getErrorStatusCode(error) >= 500;
    },
  });
}

export function captureSentryException(error, context = {}) {
  const normalizedError = normalizeError(error);

  if (!sentryInitialized || !shouldReportErrorToSentry(normalizedError)) {
    return null;
  }

  return Sentry.withScope((scope) => {
    if (context.level) {
      scope.setLevel(context.level);
    }

    if (context.tags) {
      scope.setTags(context.tags);
    }

    if (context.extra) {
      scope.setExtras(context.extra);
    }

    if (context.user) {
      scope.setUser(context.user);
    }

    return Sentry.captureException(normalizedError);
  });
}

export async function flushSentry(timeoutMs = 2000) {
  if (!sentryInitialized) {
    return false;
  }

  return Sentry.flush(timeoutMs);
}
