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
  if (error instanceof Error && error.message === 'CANDIDATE_MEDIA_TOO_LARGE')
    error = new ApiError(
      422,
      'CANDIDATE_MEDIA_TOO_LARGE',
      'Page images exceed the 20 MiB publishing limit. Reduce image sizes before publishing.',
    );
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
