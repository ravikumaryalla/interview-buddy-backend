import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'

const router = Router()

// GET /api/billing/transactions  — user's credit history
router.get('/transactions', async (req: Request, res: Response) => {
  const page = Number(req.query.page) || 1
  const limit = 20
  const skip = (page - 1) * limit

  const [transactions, total] = await Promise.all([
    prisma.creditTransaction.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.creditTransaction.count({ where: { userId: req.user!.userId } }),
  ])

  res.json({ transactions, total, page, pages: Math.ceil(total / limit) })
})

export default router
