import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Outbound email service.
 * High-fidelity HTML emails themed to match the Embedo app & status page design system.
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
      from: env.MAIL_FROM || env.SMTP_USER || 'Embedo <noreply@embedo.ai>',
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
  }

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    const text = `We received a request to reset your Embedo.ai password.\n\nReset your password here (link expires in 1 hour):\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`;
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #021316; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #021316; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 560px; background-color: #06262B; border: 1px solid #075F69; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
          <tr>
            <td style="padding: 28px 32px 20px 32px; border-bottom: 1px solid rgba(7, 95, 105, 0.4);">
              <span style="font-size: 15px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #20E6E0;">
                EMBEDO<span style="color: #EAF6F6;">.AI</span>
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 32px 28px 32px;">
              <h1 style="color: #EAF6F6; font-size: 20px; font-weight: 600; margin: 0 0 14px 0;">Reset Your Password</h1>
              <p style="color: #9CD7D5; font-size: 14px; line-height: 1.65; margin: 0 0 24px 0;">
                We received a request to reset your Embedo.ai password. Click the button below to choose a new password. This link expires in 1 hour.
              </p>
              <div style="margin: 28px 0;">
                <a href="${resetUrl}" style="display: inline-block; background-color: #20E6E0; color: #021316; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; text-decoration: none; padding: 12px 28px; border-radius: 9999px;">
                  Reset Password →
                </a>
              </div>
              <p style="color: #67B7B4; font-size: 12px; line-height: 1.6; margin: 24px 0 0 0;">
                If you did not request a password reset, you can safely ignore this email. Your password will not change.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await this.send({ to, subject: 'Reset your Embedo.ai password', text, html });
  }

  async sendOtpVerification(to: string, otpCode: string): Promise<void> {
    const text = `Your Embedo.ai verification code is: ${otpCode}\n\nThis code expires in 10 minutes.\n\nIf you did not request this verification code, please ignore this email.`;
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #021316; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #021316; padding: 40px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 560px; background-color: #06262B; border: 1px solid #075F69; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
          
          <!-- Brand Header -->
          <tr>
            <td style="padding: 26px 32px 20px 32px; border-bottom: 1px solid rgba(7, 95, 105, 0.4);">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <span style="font-size: 15px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #20E6E0;">
                      EMBEDO<span style="color: #EAF6F6;">.AI</span>
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; background-color: rgba(32, 230, 224, 0.12); color: #20E6E0; border: 1px solid rgba(32, 230, 224, 0.3);">
                      Account Verification
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 32px 32px 28px 32px;">
              <h1 style="color: #EAF6F6; font-size: 20px; font-weight: 600; margin: 0 0 14px 0;">Verify your email address</h1>
              <p style="color: #9CD7D5; font-size: 14px; line-height: 1.65; margin: 0 0 24px 0;">
                Welcome to Embedo.ai! Use the 5-digit verification code below to verify your email address and activate your account.
              </p>

              <!-- OTP Code Display Card -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 24px 0 28px 0;">
                <tr>
                  <td align="center" style="background-color: #021316; border: 1px solid #075F69; border-radius: 12px; padding: 22px 28px;">
                    <div style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 38px; font-weight: 700; letter-spacing: 14px; color: #20E6E0; text-align: center; text-indent: 14px;">
                      ${otpCode}
                    </div>
                  </td>
                </tr>
              </table>

              <p style="color: #67B7B4; font-size: 13px; line-height: 1.6; margin: 0 0 16px 0;">
                ⏱ <strong>This code expires in 10 minutes.</strong> For your security, never share this code with anyone.
              </p>
              <p style="color: #4A5C62; font-size: 12px; line-height: 1.5; margin: 0;">
                If you did not attempt to create an Embedo account, no action is needed. Your email will not be registered without this code.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 18px 32px 22px 32px; background-color: rgba(2, 19, 22, 0.6); border-top: 1px solid rgba(7, 95, 105, 0.3);">
              <p style="color: #4A5C62; font-size: 11px; margin: 0; line-height: 1.5;">
                Embedo.ai — Automated embedded systems architecture & engineering.<br>
                Security assurance: All sessions and identity verifications are cryptographically enforced.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await this.send({ to, subject: `Your Embedo verification code: ${otpCode}`, text, html });
  }

  async sendStatusSubscriptionConfirmation(to: string, unsubscribeToken: string): Promise<void> {
    const unsubUrl = `https://status.embedo.ai/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
    const text = `You have been subscribed to Embedo system status and incident alerts.\n\nWhenever an operational event, maintenance, or service disruption affects Embedo services (Embedo App, Architect Mode, AI Generation, Authentication, Storage), you will receive notifications here.\n\nLive dashboard: https://status.embedo.ai\n\nTo unsubscribe: ${unsubUrl}`;
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #021316; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #021316; padding: 40px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 560px; background-color: #06262B; border: 1px solid #075F69; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
          
          <!-- Brand Header -->
          <tr>
            <td style="padding: 26px 32px 20px 32px; border-bottom: 1px solid rgba(7, 95, 105, 0.4);">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <span style="font-size: 15px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #20E6E0;">
                      EMBEDO<span style="color: #EAF6F6;">.AI</span>
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; background-color: rgba(32, 230, 224, 0.12); color: #20E6E0; border: 1px solid rgba(32, 230, 224, 0.3);">
                      ● System Status
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Body -->
          <tr>
            <td style="padding: 32px 32px 28px 32px;">
              <h1 style="color: #EAF6F6; font-size: 20px; font-weight: 600; margin: 0 0 14px 0; line-height: 1.35; letter-spacing: -0.01em;">
                Status Notifications Subscribed
              </h1>
              <p style="color: #9CD7D5; font-size: 14px; line-height: 1.65; margin: 0 0 20px 0;">
                You are now subscribed to real-time incident notifications and operational status updates for the Embedo platform.
              </p>

              <!-- Services Monitored Box -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #021316; border: 1px solid #075F69; border-radius: 10px; margin: 20px 0 26px 0;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: #20E6E0; margin-bottom: 6px;">
                      Monitored Platform Services
                    </div>
                    <div style="color: #EAF6F6; font-size: 13px; line-height: 1.6;">
                      Embedo App • Architect Mode • AI Generation • Prototype Engine • Cloud Storage • Authentication
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Call to Action Button -->
              <div style="margin: 28px 0 10px 0;">
                <a href="https://status.embedo.ai" style="display: inline-block; background-color: #20E6E0; color: #021316; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; text-decoration: none; padding: 12px 28px; border-radius: 9999px; text-align: center;">
                  Open Live Status Dashboard →
                </a>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px 24px 32px; background-color: rgba(2, 19, 22, 0.6); border-top: 1px solid rgba(7, 95, 105, 0.4);">
              <p style="font-size: 12px; color: #67B7B4; line-height: 1.6; margin: 0;">
                You received this alert because you subscribed at <a href="https://status.embedo.ai" style="color: #20E6E0; text-decoration: none;">status.embedo.ai</a>.<br />
                To stop receiving updates: <a href="${unsubUrl}" style="color: #20E6E0; text-decoration: underline;">Unsubscribe from status alerts</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await this.send({ to, subject: 'Subscribed to Embedo Status Updates', text, html });
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

    const isResolved = params.incident.status === 'resolved';
    const isOutage = params.incident.severity === 'major_outage';
    const pillBg = isResolved ? 'rgba(32, 230, 224, 0.15)' : isOutage ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)';
    const pillColor = isResolved ? '#20E6E0' : isOutage ? '#f87171' : '#fbbf24';
    const pillBorder = isResolved ? 'rgba(32, 230, 224, 0.35)' : isOutage ? 'rgba(239, 68, 68, 0.35)' : 'rgba(245, 158, 11, 0.35)';

    const text = `Embedo Incident Alert: ${params.incident.title}\nStatus: ${statusUpper}\nSeverity: ${params.incident.severity}\nAffected Services: ${servicesStr}\n\n${params.incident.updateMessage || params.incident.description || ''}\n\nLive dashboard: https://status.embedo.ai\nUnsubscribe: ${unsubUrl}`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #021316; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #021316; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 560px; background-color: #06262B; border: 1px solid #075F69; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
          
          <!-- Header -->
          <tr>
            <td style="padding: 26px 32px 20px 32px; border-bottom: 1px solid rgba(7, 95, 105, 0.4);">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <span style="font-size: 15px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #20E6E0;">
                      EMBEDO<span style="color: #EAF6F6;">.AI</span>
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; background-color: ${pillBg}; color: ${pillColor}; border: 1px solid ${pillBorder};">
                      ● ${statusUpper}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Incident Content -->
          <tr>
            <td style="padding: 32px 32px 28px 32px;">
              <h1 style="color: #EAF6F6; font-size: 20px; font-weight: 600; margin: 0 0 10px 0; line-height: 1.35;">
                ${params.incident.title}
              </h1>
              <p style="color: #9CD7D5; font-size: 13px; margin: 0 0 20px 0;">
                <strong style="color: #EAF6F6;">Affected Systems:</strong> ${servicesStr}
              </p>

              <!-- Incident Update Box -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #021316; border-left: 4px solid ${pillColor}; border-radius: 6px; margin: 20px 0 26px 0;">
                <tr>
                  <td style="padding: 16px 20px; color: #EAF6F6; font-size: 13.5px; line-height: 1.6;">
                    ${params.incident.updateMessage || params.incident.description || 'Service update posted.'}
                  </td>
                </tr>
              </table>

              <!-- Button -->
              <div style="margin: 28px 0 10px 0;">
                <a href="https://status.embedo.ai" style="display: inline-block; background-color: #20E6E0; color: #021316; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; text-decoration: none; padding: 12px 28px; border-radius: 9999px; text-align: center;">
                  View Live Incident Dashboard →
                </a>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px 24px 32px; background-color: rgba(2, 19, 22, 0.6); border-top: 1px solid rgba(7, 95, 105, 0.4);">
              <p style="font-size: 12px; color: #67B7B4; line-height: 1.6; margin: 0;">
                Track real-time resolution on <a href="https://status.embedo.ai" style="color: #20E6E0; text-decoration: none;">status.embedo.ai</a>.<br />
                <a href="${unsubUrl}" style="color: #67B7B4; text-decoration: underline;">Unsubscribe from status alerts</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await this.send({ to: params.to, subject, text, html });
  }
}

export const emailService = new EmailService();
