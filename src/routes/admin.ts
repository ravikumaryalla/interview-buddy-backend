import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { addCredits, deductCredits } from '../services/credits'
import { sendWelcomeEmail } from '../services/email'

const router = Router()

// GET /api/admin/stats
router.get('/stats', async (_req, res) => {
  const now = new Date()
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const [
    totalUsers,
    activeLast7d,
    activeToday,
    newUsersLast30d,
    totalCreditsConsumed,
    creditsConsumedToday,
    revenueRows,
    featureBreakdown,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastActiveAt: { gte: last7d } } }),
    prisma.user.count({ where: { lastActiveAt: { gte: today } } }),
    prisma.user.count({ where: { createdAt: { gte: last30d } } }),
    prisma.apiUsageLog.aggregate({ _sum: { creditsConsumed: true } }),
    prisma.apiUsageLog.aggregate({
      where: { createdAt: { gte: today } },
      _sum: { creditsConsumed: true },
    }),
    prisma.creditTransaction.aggregate({
      where: { type: 'BONUS' },
      _sum: { amount: true },
    }),
    prisma.apiUsageLog.groupBy({
      by: ['feature'],
      _count: { feature: true },
      _sum: { creditsConsumed: true },
    }),
  ])

  res.json({
    users: {
      total: totalUsers,
      activeToday,
      activeLast7d,
      newLast30d: newUsersLast30d,
    },
    credits: {
      totalConsumed: totalCreditsConsumed._sum.creditsConsumed ?? 0,
      consumedToday: creditsConsumedToday._sum.creditsConsumed ?? 0,
      totalIssued: revenueRows._sum?.amount ?? 0,
    },
    features: featureBreakdown.map((f) => ({
      feature: f.feature,
      calls: f._count.feature,
      creditsConsumed: f._sum.creditsConsumed ?? 0,
    })),
  })
})

// POST /api/admin/users — create a user directly (no email verification)
router.post('/users', async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(100),
    email: z.string().email(),
    password: z.string().min(8).max(100),
    role: z.enum(['USER', 'ADMIN']).optional().default('USER'),
    credits: z.number().int().min(0).optional(),
  })

  const body = schema.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() })
    return
  }

  const { name, email, password, role, credits } = body.data

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    res.status(409).json({ error: 'Email already in use' })
    return
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  })

  const initialCredits = credits ?? Number(process.env.FREE_CREDITS_ON_SIGNUP || 20)
  await addCredits(user.id, initialCredits, 'BONUS', 'Admin-created account bonus credits')

  await sendWelcomeEmail(email, name, initialCredits).catch(() => {})

  res.status(201).json({ ...user, credits: initialCredits })
})

// GET /api/admin/users?page=1&search=email&status=active
router.get('/users', async (req, res) => {
  const page = Number(req.query.page) || 1
  const limit = 25
  const skip = (page - 1) * limit
  const search = String(req.query.search || '')
  const status = req.query.status as string | undefined

  const where = {
    ...(search ? { OR: [{ email: { contains: search } }, { name: { contains: search } }] } : {}),
    ...(status === 'active' ? { isActive: true } : {}),
    ...(status === 'banned' ? { isActive: false } : {}),
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastActiveAt: true,
        credits: { select: { balance: true, lifetimeTotal: true } },
        _count: { select: { usageLogs: true } },
      },
    }),
    prisma.user.count({ where }),
  ])

  res.json({ users, total, page, pages: Math.ceil(total / limit) })
})

// GET /api/admin/users/:id
router.get('/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      credits: true,
      transactions: { orderBy: { createdAt: 'desc' }, take: 50 },
      usageLogs: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  })

  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  res.json(user)
})

// PUT /api/admin/users/:id/credits
router.put('/users/:id/credits', async (req, res) => {
  const schema = z.object({
    amount: z.number().int().refine((n) => n !== 0, { message: 'Amount cannot be zero' }),
    reason: z.string().min(3),
  })

  const body = schema.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() })
    return
  }

  const amount = body.data.amount as number
  const reason = body.data.reason as string
  const userId = req.params.id

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  if (amount > 0) {
    await addCredits(userId, amount, 'BONUS', `Admin adjustment: ${reason}`)
  } else {
    await deductCredits(userId, Math.abs(amount), `Admin deduction: ${reason}`)
  }

  res.json({ message: `Credits ${amount > 0 ? 'added' : 'deducted'} successfully` })
})

// PUT /api/admin/users/:id/ban
router.put('/users/:id/ban', async (req, res) => {
  const schema = z.object({ ban: z.boolean() })
  const body = schema.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() })
    return
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { isActive: !body.data.ban },
    select: { id: true, email: true, isActive: true },
  })

  res.json(user)
})

// GET /api/admin/usage-logs?feature=SOLVE&page=1
router.get('/usage-logs', async (req, res) => {
  const page = Number(req.query.page) || 1
  const limit = 50
  const skip = (page - 1) * limit
  const feature = req.query.feature as string | undefined

  const where = feature ? { feature: feature as any } : {}

  const [logs, total] = await Promise.all([
    prisma.apiUsageLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, name: true } } },
    }),
    prisma.apiUsageLog.count({ where }),
  ])

  res.json({ logs, total, page, pages: Math.ceil(total / limit) })
})

// GET /api/admin/credits-issued?period=daily|weekly|monthly
router.get('/credits-issued', async (req, res) => {
  const period = (req.query.period as string) || 'daily'
  const days = period === 'monthly' ? 365 : period === 'weekly' ? 90 : 30
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const transactions = await prisma.creditTransaction.findMany({
    where: { type: 'BONUS', createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: { amount: true, createdAt: true },
  })

  // Group by date bucket
  const grouped: Record<string, number> = {}
  for (const tx of transactions) {
    const d = tx.createdAt
    let key: string
    if (period === 'monthly') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    } else if (period === 'weekly') {
      const week = Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000))
      key = `week-${week}`
    } else {
      key = d.toISOString().slice(0, 10)
    }
    grouped[key] = (grouped[key] ?? 0) + tx.amount
  }

  res.json(Object.entries(grouped).map(([date, credits]) => ({ date, credits })))
})

export default router
