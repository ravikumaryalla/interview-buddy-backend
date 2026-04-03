import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { addCredits } from '../services/credits'
import { sendPasswordResetEmail, sendWelcomeEmail } from '../services/email'
import { jwtGuard } from '../middleware/auth'

const router = Router()

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(100),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

function signTokens(userId: string, email: string, role: string) {
  const accessToken = jwt.sign(
    { userId, email, role },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' },
  )
  const refreshToken = jwt.sign(
    { userId, email, role },
    process.env.JWT_REFRESH_SECRET as string,
    { expiresIn: '7d' },
  )
  return { accessToken, refreshToken }
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const body = registerSchema.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() })
    return
  }

  const { name, email, password } = body.data

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    res.status(409).json({ error: 'Email already in use' })
    return
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({
    data: { name, email, passwordHash },
  })

  const freeCredits = Number(process.env.FREE_CREDITS_ON_SIGNUP || 20)
  await addCredits(user.id, freeCredits, 'BONUS', 'Welcome bonus credits')

  await sendWelcomeEmail(email, name, freeCredits).catch(() => {})

  const { accessToken, refreshToken } = signTokens(user.id, user.email, user.role)

  res.status(201).json({
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  })
})

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const body = loginSchema.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() })
    return
  }

  const { email, password } = body.data

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !user.isActive) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastActiveAt: new Date() },
  })

  const { accessToken, refreshToken } = signTokens(user.id, user.email, user.role)

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  })
})

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body
  if (!refreshToken) {
    res.status(400).json({ error: 'Refresh token required' })
    return
  }

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as {
      userId: string
      email: string
      role: string
    }

    const { accessToken, refreshToken: newRefreshToken } = signTokens(
      payload.userId,
      payload.email,
      payload.role,
    )

    res.json({ accessToken, refreshToken: newRefreshToken })
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' })
  }
})

// POST /api/auth/logout
router.post('/logout', jwtGuard, async (_req, res) => {
  res.json({ message: 'Logged out successfully' })
})

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body
  if (!email) {
    res.status(400).json({ error: 'Email required' })
    return
  }

  const user = await prisma.user.findUnique({ where: { email } })
  // Always return success to prevent email enumeration
  if (!user) {
    res.json({ message: 'If that email exists, a reset link has been sent' })
    return
  }

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  await prisma.passwordReset.create({ data: { userId: user.id, token, expiresAt } })
  await sendPasswordResetEmail(email, token).catch(() => {})

  res.json({ message: 'If that email exists, a reset link has been sent' })
})

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body
  if (!token || !password || password.length < 8) {
    res.status(400).json({ error: 'Valid token and password (min 8 chars) required' })
    return
  }

  const reset = await prisma.passwordReset.findUnique({ where: { token } })
  if (!reset || reset.used || reset.expiresAt < new Date()) {
    res.status(400).json({ error: 'Invalid or expired reset token' })
    return
  }

  const passwordHash = await bcrypt.hash(password, 12)
  await prisma.$transaction([
    prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
    prisma.passwordReset.update({ where: { id: reset.id }, data: { used: true } }),
  ])

  res.json({ message: 'Password reset successfully' })
})

export default router
