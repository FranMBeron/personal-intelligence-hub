import type {
  ApiProblemCode,
} from "@personal-intelligence-hub/contracts";

export type ProblemValidationError = Readonly<{
  path: string;
  message: string;
  code: string;
}>;

export class ApplicationError extends Error {
  readonly code: ApiProblemCode;
  readonly validationErrors: readonly ProblemValidationError[] | undefined;
  readonly currentEtag: string | undefined;
  readonly replayed: boolean;
  readonly storedRequestId: string | undefined;
  readonly responseHeaders: Readonly<Record<string, string>> | undefined;

  constructor(
    code: ApiProblemCode,
    options: Readonly<{
      cause?: unknown;
      validationErrors?: readonly ProblemValidationError[];
      currentEtag?: string;
      replayed?: boolean;
      storedRequestId?: string;
      responseHeaders?: Readonly<Record<string, string>>;
    }> = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.validationErrors = options.validationErrors;
    this.currentEtag = options.currentEtag;
    this.replayed = options.replayed ?? false;
    this.storedRequestId = options.storedRequestId;
    this.responseHeaders = options.responseHeaders;
  }
}

export class AuthenticationRequiredError extends ApplicationError {
  constructor() {
    super("authentication_required");
  }
}

export class InvalidTokenError extends ApplicationError {
  constructor(cause?: unknown) {
    super("invalid_token", cause === undefined ? {} : { cause });
  }
}

export class ForbiddenError extends ApplicationError {
  constructor() {
    super("forbidden");
  }
}

export class ValidationError extends ApplicationError {
  constructor(validationErrors: readonly ProblemValidationError[]) {
    super("validation_failed", { validationErrors });
  }
}

export class NotFoundError extends ApplicationError {
  constructor() {
    super("not_found");
  }
}

export class PreconditionRequiredError extends ApplicationError {
  constructor() {
    super("precondition_required");
  }
}

export class VersionConflictError extends ApplicationError {
  constructor(currentEtag?: string) {
    super(
      "version_conflict",
      currentEtag === undefined ? {} : { currentEtag },
    );
  }
}

export class IdempotencyKeyRequiredError extends ApplicationError {
  constructor() {
    super("idempotency_key_required");
  }
}

export class IdempotencyKeyReusedError extends ApplicationError {
  constructor() {
    super("idempotency_key_reused");
  }
}

export class InvalidCursorError extends ApplicationError {
  constructor(cause?: unknown) {
    super("invalid_cursor", cause === undefined ? {} : { cause });
  }
}

export class CursorExpiredError extends ApplicationError {
  constructor() {
    super("cursor_expired");
  }
}

export class ConflictError extends ApplicationError {
  constructor() {
    super("conflict");
  }
}

export class DependencyUnavailableError extends ApplicationError {
  constructor(cause?: unknown) {
    super(
      "dependency_unavailable",
      cause === undefined ? {} : { cause },
    );
  }
}
