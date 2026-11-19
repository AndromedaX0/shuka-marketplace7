import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { ShukaDatabase } from './database/connection.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'shuka_sid';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export type MarketplaceRole = 'buyer' | 'seller' | 'admin';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        fullName: string;
        role: MarketplaceRole;
      };
      sessionId?: string;
      csrfToken?: string;
    }
  }
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 12);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function getSessionId(req: Request): string | undefined {
  try {
    return parseCookie(req.headers.cookie ?? '')[SESSION_COOKIE];
  } catch {
    return undefined;
  }
}

export function createSession(
  db: ShukaDatabase,
  user: NonNullable<Request['user']>,
): { sid: string; csrfToken: string } {
  const sid = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const expiredAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  db.prepare('INSERT INTO sessions(sid, sess, expired_at) VALUES (?, ?, ?)').run(
    sid,
    JSON.stringify({ userId: user.id, csrfToken }),
    expiredAt,
  );
  return { sid, csrfToken };
}

export function setSessionCookie(res: Response, sid: string): void {
  res.append('Set-Cookie', stringifySetCookie({
    name: SESSION_COOKIE,
    value: sid,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  }));
}

export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', stringifySetCookie({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  }));
}

export function authenticate(db: ShukaDatabase) {
  const hasAdminsTable = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='admins'",
  ).get());

  const findUser = hasAdminsTable
    ? db.prepare(`SELECT u.id, u.email, u.full_name,
        CASE WHEN a.user_id IS NULL THEN u.role ELSE 'admin' END AS role
    FROM users u LEFT JOIN admins a ON a.user_id=u.id WHERE u.id=? AND u.is_active=1`)
    : db.prepare(`SELECT id, email, full_name, role FROM users WHERE id=? AND is_active=1`);

  return (req: Request, _res: Response, next: NextFunction) => {
    const sid = getSessionId(req);
    if (!sid) {
      next();
      return;
    }

    const session = db.prepare('SELECT sess, expired_at FROM sessions WHERE sid=?').get(sid) as
      | { sess: string; expired_at: number }
      | undefined;
    if (!session) {
      next();
      return;
    }

    if (session.expired_at <= Math.floor(Date.now() / 1000)) {
      db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
      next();
      return;
    }

    let data: { userId?: unknown; csrfToken?: unknown };
    try {
      data = JSON.parse(session.sess) as { userId?: unknown; csrfToken?: unknown };
    } catch {
      db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
      next();
      return;
    }

    if (typeof data.userId !== 'string' || typeof data.csrfToken !== 'string') {
      db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
      next();
      return;
    }

    const user = findUser.get(data.userId) as
      | { id: string; email: string; full_name: string; role: string }
      | undefined;
    if (!user || !['buyer', 'seller', 'admin'].includes(user.role)) {
      next();
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role as MarketplaceRole,
    };
    req.sessionId = sid;
    req.csrfToken = data.csrfToken;
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new HttpError(401, 'Authentication required', 'UNAUTHORIZED'));
    return;
  }
  next();
}

export function requireRole(...roles: MarketplaceRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new HttpError(401, 'Authentication required', 'UNAUTHORIZED'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new HttpError(403, 'Insufficient permissions', 'FORBIDDEN'));
      return;
    }
    next();
  };
}

export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  const supplied = req.get('x-csrf-token');
  if (!req.csrfToken || !supplied) {
    next(new HttpError(403, 'CSRF token required', 'CSRF_INVALID'));
    return;
  }
  const expectedBuffer = Buffer.from(req.csrfToken);
  const suppliedBuffer = Buffer.from(supplied);
  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    next(new HttpError(403, 'Invalid CSRF token', 'CSRF_INVALID'));
    return;
  }
  next();
}
