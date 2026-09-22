export type ErrorCode =
  | 'CONSENT_REQUIRED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_READY'
  | 'CONTENT_POLICY_VIOLATION'
  | 'ACCOUNT_SUSPENDED'
  | 'CLARIFICATION_REQUIRED'
  | 'RATE_LIMITED'
  | 'GUEST_QUOTA_EXCEEDED'
  | 'SESSION_QUOTA_EXCEEDED'
  | 'PROVIDER_UNAVAILABLE'
  | 'EXPORT_FORMAT_UNSUPPORTED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_SERVER_ERROR';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown> | unknown[];

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown> | unknown[]
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}
