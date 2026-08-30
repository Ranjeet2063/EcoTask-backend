import { NextFunction, Request, Response } from 'express';

export type AsyncRequestHandler<
  Req extends Request = Request,
  Res extends Response = Response,
> = (req: Req, res: Res, next: NextFunction) => Promise<unknown>;

/**
 * Wraps an async Express handler (route or middleware) so a rejected promise
 * is forwarded to `next(err)` instead of becoming an unhandled rejection.
 * Express 4 only catches synchronous throws; any `await` that rejects inside
 * a bare `async` handler bypasses `errorHandler` entirely and, under Node's
 * default `--unhandled-rejections=throw`, crashes the process.
 */
export function asyncHandler<
  Req extends Request = Request,
  Res extends Response = Response,
>(fn: AsyncRequestHandler<Req, Res>) {
  return (req: Req, res: Res, next: NextFunction): Promise<void> => {
    return Promise.resolve(fn(req, res, next)).then(() => undefined, next);
  };
}
