import { Request, Response, NextFunction } from 'express'
import { prisma } from '../lib/prisma'

// Credit costs per feature
export const CREDIT_COSTS: Record<string, number> = {
  solve_standard: 5,   // GPT-4o, GPT-4.1
  solve_reasoning: 15, // o1, o3, o4-mini
  chat: 2,
  transcribe: 3,
  realtime: 10,        // per minute
}

export async function requireCredits(req: Request, res: Response, next: NextFunction) {
  const userId = req.user!.userId

  const credits = await prisma.credits.findUnique({ where: { userId } })
  if (!credits || credits.balance <= 0) {
    res.status(402).json({
      error: 'Insufficient credits',
      balance: credits?.balance ?? 0,
    })
    return
  }

  next()
}
