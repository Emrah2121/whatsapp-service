import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';

function timingSafeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  if (bufferA.length !== bufferB.length) {
    // Still run a comparison of equal-length buffers so the response time
    // doesn't leak the correct secret's length.
    crypto.timingSafeEqual(bufferA, bufferA);

    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

export function verifyInternalSecret(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('Authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token || !timingSafeEquals(token, config.internalApiSecret)) {
    res.status(401).json({ success: false, message: 'Unauthorized.', data: null, errors: null });

    return;
  }

  next();
}
