import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../src/utils/asyncHandler';

function mockReqRes() {
  const req = {} as Request;
  const res = { json: jest.fn() } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('asyncHandler', () => {
  it('does not call next when the wrapped handler resolves', async () => {
    const { req, res, next } = mockReqRes();
    const handler = asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    });

    handler(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a rejected promise to next(err) instead of throwing', async () => {
    const { req, res, next } = mockReqRes();
    const err = new Error('boom');
    const handler = asyncHandler(async () => {
      throw err;
    });

    expect(() => handler(req, res, next)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledWith(err);
  });

  it('forwards a rejection from an awaited dependency', async () => {
    const { req, res, next } = mockReqRes();
    const err = new Error('db timeout');
    const handler = asyncHandler(async () => {
      await Promise.reject(err);
    });

    handler(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledWith(err);
  });

  it('passes req, res, and next through to the wrapped handler', async () => {
    const { req, res, next } = mockReqRes();
    const fn = jest.fn().mockResolvedValue(undefined);
    const handler = asyncHandler(fn);

    handler(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fn).toHaveBeenCalledWith(req, res, next);
  });
});
