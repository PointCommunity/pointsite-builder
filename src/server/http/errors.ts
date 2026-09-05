export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: FieldError[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  const safeError =
    error instanceof ApiError
      ? error
      : new ApiError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  const body = {
    code: safeError.code,
    message: safeError.message,
    requestId,
    ...(safeError.fieldErrors ? { fieldErrors: safeError.fieldErrors } : {}),
  };
  return Response.json(body, { status: safeError.status });
}
