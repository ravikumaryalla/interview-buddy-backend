import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { getBalance } from '../services/credits';

const router = Router();

// ── Pack definitions ──────────────────────────────────────
const PACKS: Record<
  string,
  { label: string; amount: number; credits: number; currency: string }
> = {
  starter: { label: 'Starter', amount: 399, credits: 400, currency: 'INR' },
  popular: { label: 'Popular', amount: 599, credits: 650, currency: 'INR' },
  pro: { label: 'Pro', amount: 899, credits: 1000, currency: 'INR' },
};

// ── Cashfree helpers ──────────────────────────────────────
function cashfreeBaseUrl() {
  const env = process.env.CASHFREE_ENV || 'sandbox';
  return env === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

function cashfreeHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-version': '2023-08-01',
    'x-client-id': process.env.CASHFREE_APP_ID!,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY!,
  };
}

// ── POST /api/billing/create-order ────────────────────────
router.post('/create-order', async (req: Request, res: Response) => {
  const schema = z.object({ packId: z.string() });
  const body = schema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() });
    return;
  }

  const pack = PACKS[body.data.packId];
  if (!pack) {
    res.status(400).json({ error: 'Invalid packId' });
    return;
  }

  const userId = req.user!.userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Create a unique order ID prefixed with our app name
  const cashfreeOrderId = `ib_${userId.slice(-8)}_${Date.now()}`;

  const cfPayload: Record<string, unknown> = {
    order_id: cashfreeOrderId,
    order_amount: pack.amount,
    order_currency: pack.currency,
    customer_details: {
      customer_id: userId.replace(/[^a-zA-Z0-9_-]/g, ''),
      customer_name: user.name,
      customer_email: user.email,
      customer_phone: '9999999999', // required by Cashfree; update if you collect phone
    },
  };

  cfPayload.order_meta = {
    return_url: `https://interviewbuddy.techrax.in/payment/success?orderId=${cashfreeOrderId}`,
    ...(process.env.CASHFREE_WEBHOOK_URL
      ? { notify_url: process.env.CASHFREE_WEBHOOK_URL }
      : {}),
  };

  const cfRes = await fetch(`${cashfreeBaseUrl()}/orders`, {
    method: 'POST',
    headers: cashfreeHeaders(),
    body: JSON.stringify(cfPayload),
  });

  if (!cfRes.ok) {
    const err = await cfRes.json().catch(() => ({}));
    console.error(
      '[Cashfree] create-order failed',
      cfRes.status,
      JSON.stringify(err),
    );
    res.status(502).json({ error: 'Payment provider error', details: err });
    return;
  }

  const cfData = (await cfRes.json()) as {
    order_id: string;
    payment_session_id: string;
  };

  // Persist the order locally so we can credit idempotently on verify
  await prisma.order.create({
    data: {
      userId,
      cashfreeOrderId: cfData.order_id,
      packId: body.data.packId,
      amount: pack.amount,
      credits: pack.credits,
      status: 'PENDING',
    },
  });

  res.json({
    orderId: cfData.order_id,
    paymentSessionId: cfData.payment_session_id,
    amount: pack.amount,
    currency: pack.currency,
  });
});

// ── POST /api/billing/verify ──────────────────────────────
router.post('/verify', async (req: Request, res: Response) => {
  const schema = z.object({ orderId: z.string() });
  const body = schema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() });
    return;
  }

  const userId = req.user!.userId;
  const { orderId } = body.data;

  // Only allow verifying orders that belong to this user
  const order = await prisma.order.findUnique({
    where: { cashfreeOrderId: orderId },
  });
  if (!order || order.userId !== userId) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }

  // Already processed — return current balance without double-crediting
  if (order.status === 'PAID') {
    const balance = await getBalance(userId);
    res.json({ success: true, balance, message: 'Already credited' });
    return;
  }

  const cfRes = await fetch(`${cashfreeBaseUrl()}/orders/${orderId}`, {
    method: 'GET',
    headers: cashfreeHeaders(),
  });

  if (!cfRes.ok) {
    const err = await cfRes.json().catch(() => ({}));
    console.error('[Cashfree] verify failed', err);
    res.status(502).json({ error: 'Payment provider error', details: err });
    return;
  }

  const cfData = (await cfRes.json()) as { order_status: string };

  if (cfData.order_status === 'PAID') {
    // Mark order as PAID, upsert credits balance, and record transaction — all in one DB transaction
    await prisma.$transaction([
      prisma.order.update({
        where: { cashfreeOrderId: orderId },
        data: { status: 'PAID' },
      }),
      prisma.credits.upsert({
        where: { userId },
        update: {
          balance: { increment: order.credits },
          lifetimeTotal: { increment: order.credits },
        },
        create: {
          userId,
          balance: order.credits,
          lifetimeTotal: order.credits,
        },
      }),
      prisma.creditTransaction.create({
        data: {
          userId,
          amount: order.credits,
          type: 'PURCHASE',
          description: `Purchased ${order.credits} credits – order ${orderId}`,
        },
      }),
    ]);

    const balance = await getBalance(userId);
    res.json({ success: true, balance });
  } else {
    await prisma.order.update({
      where: { cashfreeOrderId: orderId },
      data: { status: cfData.order_status },
    });
    res.json({
      success: false,
      message: `Payment status: ${cfData.order_status}`,
    });
  }
});

// ── GET /api/billing/packs ────────────────────────────────
router.get('/packs', (_req: Request, res: Response) => {
  res.json(Object.entries(PACKS).map(([id, p]) => ({ id, ...p })));
});

// ── GET /api/billing/transactions ────────────────────────
router.get('/transactions', async (req: Request, res: Response) => {
  const page = Number(req.query.page) || 1;
  const limit = 20;
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    prisma.creditTransaction.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.creditTransaction.count({ where: { userId: req.user!.userId } }),
  ]);

  res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
});

export default router;
