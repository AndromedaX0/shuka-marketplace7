import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import type { ShukaDatabase } from './database/connection.js';
import { createApiRouter } from './routes/api.js';
import { HttpError } from './errors.js';

export interface AppOptions {
  uploadsDirectory?: string;
}

export function createApp(db: ShukaDatabase, options: AppOptions = {}) {
  const app = express();
  const uploadsDirectory = path.resolve(options.uploadsDirectory ?? process.env.UPLOADS_DIR ?? 'uploads');
  const allowedOrigins = (process.env.CORS_ORIGINS ??
    'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.use(helmet());
  const corsMiddleware = cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new HttpError(403, 'Origin is not allowed', 'CORS_FORBIDDEN'));
    },
  });
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    if (!origin || origin === requestOrigin) {
      next();
      return;
    }
    corsMiddleware(req, res, next);
  });
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createApiRouter(db, uploadsDirectory));

  app.use('/uploads', express.static(uploadsDirectory, { dotfiles: 'deny', index: false }));
  app.use(express.static(path.resolve('dist/client')));
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      next(new HttpError(404, 'API endpoint not found', 'NOT_FOUND'));
      return;
    }
    if (req.path === '/uploads' || req.path.startsWith('/uploads/')) {
      next(new HttpError(404, 'File not found', 'NOT_FOUND'));
      return;
    }

    res.sendFile(path.resolve('dist/client/index.html'), error => {
      if (error) next(error);
    });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: { code: 'FILE_TOO_LARGE', message: 'Each image must be 5 MB or smaller' },
        });
        return;
      }
      if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({
          error: { code: 'INVALID_UPLOAD', message: 'Upload up to five files using the images field' },
        });
        return;
      }
    }
    if (typeof error === 'object' && error !== null && 'status' in error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        res.status(status).json({
          error: {
            code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
            message: status === 413 ? 'Request body is too large' : 'Invalid request',
          },
        });
        return;
      }
    }
    console.error('Unhandled request error:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  };
  app.use(errorHandler);

  return app;
}