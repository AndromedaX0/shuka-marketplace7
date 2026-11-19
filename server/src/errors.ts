export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'HTTP_ERROR') {
    super(message);
  }
}

export function notFound(resource = 'Resource'): HttpError {
  return new HttpError(404, `${resource} not found`, 'NOT_FOUND');
}