export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (message: string) => new HttpError(409, message);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, message);
