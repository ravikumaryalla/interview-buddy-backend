import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { deductCredits, addCredits } from '../services/credits';
import {
  solveProblem,
  chatWithAI,
  chatWithAIStream,
  transcribeAudio,
  createRealtimeToken,
} from '../services/openai';
import { CREDIT_COSTS } from '../middleware/requireCredits';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const REASONING_MODELS = ['o1', 'o3', 'o4-mini'];

// POST /api/ai/solve
router.post('/solve', async (req, res) => {
  const schema = z.object({
    problem: z.string().min(1),
    model: z.string(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  });

  const body = schema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() });
    return;
  }

  const userId = req.user!.userId;
  const { problem, model, reasoningEffort } = body.data;
  const isReasoning = REASONING_MODELS.includes(model);
  const cost = isReasoning
    ? CREDIT_COSTS.solve_reasoning
    : CREDIT_COSTS.solve_standard;

  const deducted = await deductCredits(
    userId,
    cost,
    `Solve problem (${model})`,
  );
  if (!deducted) {
    res.status(402).json({ error: 'Insufficient credits' });
    return;
  }

  try {
    const { result, tokenCount, responseTimeMs } = await solveProblem({
      problem,
      model,
      reasoningEffort,
    });

    res.json(result);

    Promise.all([
      prisma.apiUsageLog.create({
        data: {
          userId,
          feature: 'SOLVE',
          creditsConsumed: cost,
          model,
          tokenCount,
          responseTimeMs,
        },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { lastActiveAt: new Date() },
      }),
    ]).catch((err) => console.error('[AI] solve log failed:', err));
  } catch (err) {
    await addCredits(userId, cost, 'REFUND', `Refund: solve failed (${model})`);
    throw err;
  }
});

// POST /api/ai/chat
router.post('/chat', async (req, res) => {
  const schema = z.object({
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant', 'system']),
          content: z.string(),
        }),
      )
      .min(1),
    model: z.string(),
  });

  const body = schema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() });
    return;
  }

  const userId = req.user!.userId;
  const cost = CREDIT_COSTS.chat;

  const deducted = await deductCredits(
    userId,
    cost,
    `Chat (${body.data.model})`,
  );
  if (!deducted) {
    res.status(402).json({ error: 'Insufficient credits' });
    return;
  }

  try {
    const { message, tokenCount, responseTimeMs } = await chatWithAI(body.data);

    res.json({ message });

    Promise.all([
      prisma.apiUsageLog.create({
        data: {
          userId,
          feature: 'CHAT',
          creditsConsumed: cost,
          model: body.data.model,
          tokenCount,
          responseTimeMs,
        },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { lastActiveAt: new Date() },
      }),
    ]).catch((err) => console.error('[AI] chat log failed:', err));
  } catch (err) {
    await addCredits(userId, cost, 'REFUND', `Refund: chat failed`);
    throw err;
  }
});

// POST /api/ai/chat/stream  (SSE)
router.post('/chat/stream', async (req, res) => {
  const schema = z.object({
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant', 'system']),
          content: z.string(),
        }),
      )
      .min(1),
    model: z.string(),
  });

  const body = schema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() });
    return;
  }

  const userId = req.user!.userId;
  const cost = CREDIT_COSTS.chat;

  const deducted = await deductCredits(
    userId,
    cost,
    `Chat stream (${body.data.model})`,
  );
  if (!deducted) {
    res.status(402).json({ error: 'Insufficient credits' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { tokenCount, responseTimeMs } = await chatWithAIStream(
      body.data,
      (delta) => res.write(`data: ${JSON.stringify({ delta })}\n\n`),
      () => {
        res.write('data: [DONE]\n\n');
        res.end();
      }, // fires on finish_reason=stop, before usage chunk
    );

    // chatWithAIStream resolves after the usage chunk — tokenCount is now accurate
    Promise.all([
      prisma.apiUsageLog.create({
        data: {
          userId,
          feature: 'CHAT',
          creditsConsumed: cost,
          model: body.data.model,
          tokenCount,
          responseTimeMs,
        },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { lastActiveAt: new Date() },
      }),
    ]).catch((err) => console.error('[AI] chat/stream log failed:', err));
  } catch (err) {
    await addCredits(userId, cost, 'REFUND', 'Refund: chat stream failed');
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: 'Stream failed' })}\n\n`);
      res.end();
    }
  }
});

// POST /api/ai/transcribe  (multipart/form-data with audio file)
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Audio file required' });
    return;
  }

  const userId = req.user!.userId;
  const cost = CREDIT_COSTS.transcribe;

  const deducted = await deductCredits(userId, cost, 'Audio transcription');
  if (!deducted) {
    res.status(402).json({ error: 'Insufficient credits' });
    return;
  }

  try {
    const { text, responseTimeMs } = await transcribeAudio(
      req.file.buffer,
      req.file.originalname,
    );

    res.json({ text });

    prisma.apiUsageLog
      .create({
        data: {
          userId,
          feature: 'TRANSCRIBE',
          creditsConsumed: cost,
          model: 'whisper-1',
          responseTimeMs,
        },
      })
      .catch((err) => console.error('[AI] transcribe log failed:', err));
  } catch (err) {
    await addCredits(userId, cost, 'REFUND', `Refund: transcription failed`);
    throw err;
  }
});

// POST /api/ai/realtime-token
router.post('/realtime-token', async (req, res) => {
  const userId = req.user!.userId;
  const cost = CREDIT_COSTS.realtime;

  const deducted = await deductCredits(userId, cost, 'Realtime voice session');
  if (!deducted) {
    res.status(402).json({ error: 'Insufficient credits' });
    return;
  }

  try {
    const { clientSecret } = await createRealtimeToken();

    res.json({ clientSecret });

    Promise.all([
      prisma.apiUsageLog.create({
        data: {
          userId,
          feature: 'REALTIME',
          creditsConsumed: cost,
          model: 'gpt-4o-realtime-preview',
        },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { lastActiveAt: new Date() },
      }),
    ]).catch((err) => console.error('[AI] realtime log failed:', err));
  } catch (err) {
    await addCredits(userId, cost, 'REFUND', 'Refund: realtime session failed');
    throw err;
  }
});

export default router;
