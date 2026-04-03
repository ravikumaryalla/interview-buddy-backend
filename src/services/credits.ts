import { TransactionType } from '@prisma/client'
import { prisma } from '../lib/prisma'

export async function addCredits(
  userId: string,
  amount: number,
  type: TransactionType,
  description: string,
) {
  await prisma.$transaction([
    prisma.credits.upsert({
      where: { userId },
      update: {
        balance: { increment: amount },
        lifetimeTotal: type === 'BONUS' ? { increment: amount } : undefined,
      },
      create: {
        userId,
        balance: amount,
        lifetimeTotal: amount,
      },
    }),
    prisma.creditTransaction.create({
      data: { userId, amount, type, description },
    }),
  ])
}

export async function deductCredits(
  userId: string,
  amount: number,
  description: string,
): Promise<boolean> {
  try {
    await prisma.$transaction([
      prisma.credits.update({
        where: { userId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      }),
      prisma.creditTransaction.create({
        data: { userId, amount: -amount, type: 'USAGE', description },
      }),
    ])
    return true
  } catch {
    // Update condition failed — insufficient credits or no credits row
    return false
  }
}

export async function getBalance(userId: string): Promise<number> {
  const credits = await prisma.credits.findUnique({ where: { userId } })
  return credits?.balance ?? 0
}
