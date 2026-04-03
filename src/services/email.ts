import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
})

export async function sendPasswordResetEmail(email: string, token: string) {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Reset your Interview Buddy password',
    html: `
      <h2>Password Reset</h2>
      <p>Click the link below to reset your password. This link expires in 1 hour.</p>
      <a href="${resetUrl}" style="
        background:#6366f1;color:#fff;padding:12px 24px;
        border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px
      ">Reset Password</a>
      <p style="margin-top:16px;color:#6b7280;font-size:14px">
        If you didn't request this, you can safely ignore this email.
      </p>
    `,
  })
}

export async function sendWelcomeEmail(email: string, name: string, freeCredits: number) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Welcome to Interview Buddy!',
    html: `
      <h2>Welcome, ${name}!</h2>
      <p>Your account is ready. You have <strong>${freeCredits} free credits</strong> to get started.</p>
      <p>Use them to solve coding problems, chat with AI, and practice for your interviews.</p>
    `,
  })
}
