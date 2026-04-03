import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { getBalance } from '../services/credits'

const router = Router()

// GET /api/user/me
router.get('/me', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { id: true, name: true, email: true, role: true, createdAt: true, lastActiveAt: true },
  })

  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  const balance = await getBalance(user.id)
  res.json({ ...user, credits: balance })
})

// PUT /api/user/me
router.put('/me', async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(100).optional(),
    email: z.string().email().optional(),
  })

  const body = schema.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() })
    return
  }

  if (body.data.email) {
    const existing = await prisma.user.findFirst({
      where: { email: body.data.email, NOT: { id: req.user!.userId } },
    })
    if (existing) {
      res.status(409).json({ error: 'Email already in use' })
      return
    }
  }

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: body.data,
    select: { id: true, name: true, email: true, role: true },
  })

  res.json(user)
})

// GET /api/user/usage
router.get('/usage', async (req, res) => {
  const userId = req.user!.userId
  const days = Number(req.query.days) || 30
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const [logs, transactions, balance] = await Promise.all([
    prisma.apiUsageLog.findMany({
      where: { userId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.creditTransaction.findMany({
      where: { userId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    getBalance(userId),
  ])

  const totalConsumed = logs.reduce((sum, l) => sum + l.creditsConsumed, 0)

  res.json({ balance, totalConsumed, logs, transactions })
})

export default router
