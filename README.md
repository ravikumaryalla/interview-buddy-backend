# Interview Buddy — Backend API

Express + TypeScript REST API. Handles authentication, credit management, and acts as a secure proxy for all OpenAI calls.

---

## Stack

- **Runtime** — Node.js + TypeScript
- **Framework** — Express 4
- **Database** — PostgreSQL via Prisma ORM (Neon-compatible)
- **Cache / Sessions** — Redis (ioredis)
- **Auth** — JWT access tokens + refresh tokens (blacklisted in Redis on logout)
- **AI** — OpenAI SDK (server-side only — key never reaches the client)
- **Validation** — Zod
- **Email** — Nodemailer (password reset)
- **File uploads** — Multer (audio transcription)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PORT` | Server port (default `3001`) |
| `NODE_ENV` | `development` or `production` |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret for access tokens (64-byte random hex) |
| `JWT_EXPIRES_IN` | Access token TTL (default `15m`) |
| `JWT_REFRESH_SECRET` | Secret for refresh tokens |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL (default `7d`) |
| `OPENAI_API_KEY` | OpenAI API key |
| `SMTP_HOST` | SMTP host for emails |
| `SMTP_PORT` | SMTP port (default `587`) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From address for outgoing emails |
| `FRONTEND_URL` | Frontend origin for CORS + email links |
| `FREE_CREDITS_ON_SIGNUP` | Credits awarded to new users (default `20`) |

Generate JWT secrets:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Database

```bash
npm run db:push       # Create all tables from schema
npm run db:generate   # Generate Prisma client types
npm run db:studio     # Open Prisma Studio (GUI)
```

### 4. Start

```bash
npm run dev     # Development (ts-node-dev with hot reload)
npm run build   # Compile TypeScript
npm start       # Run compiled output
```

---

## API Reference

### Auth — `/api/auth`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | No | Create account, receive tokens + 20 free credits |
| POST | `/login` | No | Authenticate, receive tokens |
| POST | `/refresh` | No | Exchange refresh token for new access token |
| POST | `/logout` | JWT | Blacklist current token, delete refresh token |
| POST | `/forgot-password` | No | Send password reset email |
| POST | `/reset-password` | No | Reset password with email token |

**Register / Login response:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": { "id": "...", "name": "...", "email": "...", "role": "USER" }
}
```

---

### User — `/api/user` *(JWT required)*

| Method | Path | Description |
|---|---|---|
| GET | `/me` | Current user profile + credit balance |
| PUT | `/me` | Update name or email |
| GET | `/usage` | Usage logs and transaction history (last 30 days) |

---

### Billing — `/api/billing` *(JWT required)*

| Method | Path | Description |
|---|---|---|
| GET | `/transactions` | Paginated credit transaction history |

---

### AI — `/api/ai` *(JWT + credits required)*

All endpoints deduct credits before calling OpenAI. If the call fails, credits are refunded.

| Method | Path | Credits | Description |
|---|---|---|---|
| POST | `/solve` | 5 or 15 | Solve coding problem, returns solution in JS/Python/Java |
| POST | `/chat` | 2 | Chat message with optional system prompt |
| POST | `/transcribe` | 3 | Audio file → text (Whisper) |
| POST | `/realtime-token` | 10 | Get ephemeral token for OpenAI Realtime API |

**POST `/solve` body:**
```json
{
  "problem": "Given an array...",
  "model": "gpt-4o",
  "reasoningEffort": "medium"
}
```

**POST `/chat` body:**
```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Explain binary search." }
  ],
  "model": "gpt-4o"
}
```

**POST `/transcribe` body:** `multipart/form-data` with an `audio` file field.

---

### Admin — `/api/admin` *(JWT + ADMIN role required)*

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Overview: users, credits consumed/issued, feature breakdown |
| GET | `/users` | Paginated user list with search and status filter |
| GET | `/users/:id` | Single user with full transaction and usage history |
| PUT | `/users/:id/credits` | Manually add or deduct credits |
| PUT | `/users/:id/ban` | Ban or unban a user |
| GET | `/usage-logs` | System-wide API usage logs with feature filter |
| GET | `/credits-issued` | Credits issued over time, grouped by period |

**PUT `/users/:id/credits` body:**
```json
{ "amount": 100, "reason": "Promotional grant" }
```
Use a negative amount to deduct:
```json
{ "amount": -50, "reason": "Abuse correction" }
```

**GET `/stats` response:**
```json
{
  "users": { "total": 42, "activeToday": 5, "activeLast7d": 18, "newLast30d": 12 },
  "credits": { "totalConsumed": 8430, "consumedToday": 220, "totalIssued": 12000 },
  "features": [
    { "feature": "SOLVE", "calls": 310, "creditsConsumed": 1550 },
    { "feature": "CHAT",  "calls": 820, "creditsConsumed": 1640 }
  ]
}
```

---

## Database schema

```
users               — id, email, passwordHash, name, role, isActive, createdAt, lastActiveAt
credits             — userId (1:1), balance, lifetimeTotal
credit_transactions — userId, amount, type (BONUS|USAGE|REFUND), description, createdAt
api_usage_logs      — userId, feature, creditsConsumed, model, tokenCount, responseTimeMs
password_resets     — userId, token, expiresAt, used
```

---

## Credit system

Credits are tracked per-user. There is no payment integration — admins grant credits manually via the admin dashboard or API.

**Transaction types:**
| Type | When |
|---|---|
| `BONUS` | Admin grants credits, or signup welcome credits |
| `USAGE` | Credits deducted before each AI call |
| `REFUND` | Credits returned if an AI call throws an error |

**Insufficient credits:** Returns `HTTP 402` with `{ "error": "Insufficient credits" }`.

---

## Middleware

| Middleware | File | Purpose |
|---|---|---|
| `jwtGuard` | `middleware/auth.ts` | Verifies Bearer token, checks Redis blacklist |
| `adminOnly` | `middleware/adminOnly.ts` | Requires `role === 'ADMIN'` |
| `requireCredits` | `middleware/requireCredits.ts` | Rejects if credit balance is 0 |

Rate limits:
- Auth routes: 20 requests / 15 min per IP
- AI routes: 30 requests / 1 min per IP

---

## Token flow

```
Login → accessToken (15m) + refreshToken (7d, stored in Redis)
         ↓
Request with Bearer accessToken
         ↓ 401 (expired)
POST /api/auth/refresh → new accessToken + rotated refreshToken
         ↓
Logout → accessToken blacklisted in Redis, refreshToken deleted
```
