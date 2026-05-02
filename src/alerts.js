import nodemailer from 'nodemailer';

export class AlertService {
  constructor(config) {
    this.config = config;
    this.mailer = null;
  }

  async sendIdleAlert(state) {
    const subject = `Minecraft server has been empty for ${this.config.runtime.idleAlertMinutes} minutes`;
    const text = [
      subject,
      '',
      `Runtime: ${state.runtimeName ?? state.runtimeId ?? 'unknown'}`,
      `Provider: ${state.provider ?? 'unknown'}`,
      `Last heartbeat: ${state.lastHeartbeatAt ?? 'unknown'}`,
      `Players: ${state.playerCount}`,
      '',
      `Open ${this.config.app.publicBaseUrl} to stop or inspect the server.`,
    ].join('\n');

    await Promise.all([
      this.sendEmail(subject, text),
      this.sendWebhook(subject, text, state),
    ]);
  }

  async sendEmail(subject, text) {
    if (!this.config.alerts.emailEnabled) return;
    if (!this.config.alerts.smtpHost || !this.config.alerts.emailFrom || this.config.alerts.emailTo.length === 0) {
      throw new Error('Email alerting is enabled but SMTP/email settings are incomplete.');
    }
    if (!this.mailer) {
      this.mailer = nodemailer.createTransport({
        host: this.config.alerts.smtpHost,
        port: this.config.alerts.smtpPort,
        secure: this.config.alerts.smtpSecure,
        auth: this.config.alerts.smtpUser ? {
          user: this.config.alerts.smtpUser,
          pass: this.config.alerts.smtpPassword,
        } : undefined,
      });
    }
    await this.mailer.sendMail({
      from: this.config.alerts.emailFrom,
      to: this.config.alerts.emailTo.join(','),
      subject,
      text,
    });
  }

  async sendWebhook(subject, text, state) {
    if (!this.config.alerts.webhookUrl) return;
    const response = await fetch(this.config.alerts.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, text, state }),
    });
    if (!response.ok) {
      throw new Error(`Webhook alert failed: ${response.status} ${response.statusText}`);
    }
  }
}
