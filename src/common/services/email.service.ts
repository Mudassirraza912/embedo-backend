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
      logger.warn('SMTP is not configured: outbound emails cannot be delivered.');
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

  async sendStatusSubscriptionConfirmation(to: string, unsubscribeToken: string): Promise<void> {
    const unsubUrl = `https://status.embedo.ai/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
    await this.send({
      to,
      subject: 'Subscribed to Embedo Status Updates',
      text: `You have been subscribed to Embedo system status and incident alerts.\n\nWhenever an operational event, maintenance, or service disruption affects Embedo services, you will receive notifications here.\n\nLive dashboard: https://status.embedo.ai\n\nTo unsubscribe: ${unsubUrl}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #0f172a; margin-top: 0;">Embedo Status Notifications</h2>
          <p style="color: #334155; line-height: 1.6;">You have successfully subscribed to Embedo system status and incident alerts.</p>
          <p style="color: #334155; line-height: 1.6;">Whenever an operational event, scheduled maintenance, or service disruption affects Embedo services (Embedo App, Architect Mode, AI Generation, Authentication, Storage), you will receive notifications here.</p>
          <div style="margin: 24px 0;">
            <a href="https://status.embedo.ai" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 500;">View Embedo Status Page</a>
          </div>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
            You received this email because this address was subscribed to updates at <a href="https://status.embedo.ai" style="color: #64748b;">status.embedo.ai</a>.<br />
            To unsubscribe at any time: <a href="${unsubUrl}" style="color: #2563eb;">click here to unsubscribe</a>.
          </p>
        </div>
      `,
    });
  }

  async sendIncidentAlert(params: {
    to: string;
    incident: {
      title: string;
      severity: string;
      status: string;
      affectedServices?: string[];
      description?: string;
      updateMessage?: string;
    };
    unsubscribeToken?: string;
  }): Promise<void> {
    const unsubUrl = params.unsubscribeToken
      ? `https://status.embedo.ai/unsubscribe?token=${encodeURIComponent(params.unsubscribeToken)}`
      : 'https://status.embedo.ai';
    const statusUpper = params.incident.status.toUpperCase();
    const servicesStr = (params.incident.affectedServices || []).join(', ') || 'All Services';
    const subject = `[Embedo Incident Alert] ${params.incident.title} — ${statusUpper}`;

    await this.send({
      to: params.to,
      subject,
      text: `Embedo Incident Alert: ${params.incident.title}\nStatus: ${statusUpper}\nSeverity: ${params.incident.severity}\nAffected Services: ${servicesStr}\n\n${params.incident.updateMessage || params.incident.description || ''}\n\nLive dashboard: https://status.embedo.ai\nUnsubscribe: ${unsubUrl}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <div style="display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; text-transform: uppercase; margin-bottom: 12px; background-color: #fee2e2; color: #991b1b;">
            ${statusUpper}
          </div>
          <h2 style="color: #0f172a; margin-top: 0;">${params.incident.title}</h2>
          <p style="color: #475569; font-size: 14px;"><strong>Affected:</strong> ${servicesStr}</p>
          <div style="background-color: #f8fafc; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 16px 0; color: #1e293b;">
            ${params.incident.updateMessage || params.incident.description || 'Service update posted.'}
          </div>
          <div style="margin: 20px 0;">
            <a href="https://status.embedo.ai" style="display: inline-block; background-color: #0f172a; color: #ffffff; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-size: 14px;">View Live Status Dashboard</a>
          </div>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="font-size: 12px; color: #64748b;">
            <a href="${unsubUrl}" style="color: #64748b;">Unsubscribe from status alerts</a>
          </p>
        </div>
      `,
    });
  }
}

export const emailService = new EmailService();
