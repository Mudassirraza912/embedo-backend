import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Outbound email. Configured via SMTP_* env vars. When not configured, `isConfigured` is false
 * and callers must decide how to degrade — this service never pretends a message was sent.
 */
class EmailService {
  private transporter: Transporter | null = null;

  constructor() {
    if (env.SMTP_HOST && env.SMTP_PORT) {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER && env.SMTP_PASSWORD ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
        connectionTimeout: 10_000,
        socketTimeout: 15_000,
      });
    } else if (env.NODE_ENV === 'production') {
      logger.warn('SMTP is not configured: password reset emails cannot be delivered.');
    }
  }

  get isConfigured(): boolean {
    return this.transporter !== null;
  }

  async send(params: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    if (!this.transporter) {
      throw new Error('Email transport is not configured');
    }
    await this.transporter.sendMail({
      from: env.MAIL_FROM || env.SMTP_USER || 'no-reply@embedo.ai',
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
  }

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    await this.send({
      to,
      subject: 'Reset your Embedo.ai password',
      text: `We received a request to reset your Embedo.ai password.\n\nReset it here (link expires in 1 hour):\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>We received a request to reset your Embedo.ai password.</p><p><a href="${resetUrl}">Reset your password</a> (link expires in 1 hour)</p><p>If you did not request this, you can ignore this email.</p>`,
    });
  }
}

export const emailService = new EmailService();
