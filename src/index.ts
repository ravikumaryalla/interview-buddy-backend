import 'express-async-errors';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

import authRouter from './routes/auth';
import userRouter from './routes/user';
import billingRouter from './routes/billing';
import aiRouter from './routes/ai';
import adminRouter from './routes/admin';
import { jwtGuard } from './middleware/auth';
import { adminOnly } from './middleware/adminOnly';
const app = express();

// ── Security ──────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:5173',
      'app://.', // Electron production origin
      'http://localhost:5173',
    ],
    credentials: true,
  }),
);

// ── Rate limiting ─────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  message: { error: 'Too many requests, please try again later' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 30,
  message: { error: 'Rate limit exceeded' },
});

// ── Body parsing ──────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/user', jwtGuard, userRouter);
app.use('/api/billing', jwtGuard, billingRouter);
app.use('/api/ai', jwtGuard, aiLimiter, aiRouter);
app.use('/api/admin', jwtGuard, adminOnly, adminRouter);

// ── Health check ──────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 handler ───────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ──────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Error]', err.message);

  if (process.env.NODE_ENV === 'development') {
    res.status(500).json({ error: err.message, stack: err.stack });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;

app.listen(PORT, () => {
  console.log(`[Server] running on http://localhost:${PORT}`);
  console.log(`[Server] environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
