import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

export interface AuthPayload {
  userId: string
  email: string
  role: string
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

export async function jwtGuard(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' })
    return
  }

  const token = authHeader.slice(7)

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
