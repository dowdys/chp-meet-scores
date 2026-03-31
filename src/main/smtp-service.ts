import * as path from 'path';
import * as fs from 'fs';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** Safe attachment size limit — Gmail's 25MB minus base64 overhead (~33%). */
const SAFE_ATTACHMENT_BYTES = 18 * 1024 * 1024;

/** Map SMTP error messages to user-friendly strings. Never forward raw errors. */
function classifySmtpError(err: Error): string {
  const msg = err.message.toLowerCase();
  if (msg.includes('auth') || msg.includes('535') || msg.includes('username'))
    return 'Email login failed. Check your password in Settings.';
  if (msg.includes('534') || msg.includes('application-specific'))
    return 'Gmail requires an App Password, not your regular password. See setup instructions in Settings.';
  if (msg.includes('550 5.7.30'))
    return 'Microsoft 365 has disabled basic SMTP auth. Contact your IT administrator.';
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enotfound'))
    return 'Could not connect to email server. Check your internet and SMTP settings.';
  if (msg.includes('starttls'))
    return 'TLS upgrade failed. The server may require a different port.';
  return 'Email send failed. Check your SMTP settings.';
}

function createTransport(config: SmtpConfig) {
  // Lazy-load nodemailer
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,         // STARTTLS on port 587
    requireTLS: true,      // Fail if TLS upgrade refused
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
}

export async function testSmtpConnection(config: SmtpConfig): Promise<{ success: boolean; error?: string }> {
  const transporter = createTransport(config);
  try {
    await transporter.verify();
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: classifySmtpError(err instanceof Error ? err : new Error(String(err))) };
  } finally {
    transporter.close();
  }
}

export async function sendTestEmail(
  config: SmtpConfig,
  toAddress: string
): Promise<{ success: boolean; error?: string }> {
  const transporter = createTransport(config);
  try {
    await transporter.sendMail({
      from: `"CHP Meet Scores" <${config.user}>`,
      to: toAddress,
      subject: 'CHP Meet Scores \u2014 Email Test',
      text: 'Your email settings are configured correctly. This is a test message from CHP Meet Scores.',
    });
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: classifySmtpError(err instanceof Error ? err : new Error(String(err))) };
  } finally {
    transporter.close();
  }
}

export async function sendDesignerEmail(
  config: SmtpConfig,
  designerEmail: string,
  meetName: string,
  idmlPaths: string[]
): Promise<{ success: boolean; error?: string }> {
  // Validate attachment sizes
  let totalBytes = 0;
  for (const p of idmlPaths) {
    totalBytes += fs.statSync(p).size;
  }
  if (totalBytes > SAFE_ATTACHMENT_BYTES) {
    return {
      success: false,
      error: `Attachments total ${Math.round(totalBytes / 1024 / 1024)} MB, exceeding the ~18 MB safe limit for email. Consider sharing via another method.`,
    };
  }

  // Strip CRLF from meet name to prevent email header injection
  const safeMeetName = meetName.replace(/[\r\n]/g, ' ').trim();

  const transporter = createTransport(config);
  try {
    await transporter.sendMail({
      from: `"CHP Meet Scores" <${config.user}>`,
      to: designerEmail,
      subject: `Shirt back files: ${safeMeetName}`,
      text: `Attached are the InDesign files for ${safeMeetName}. Please edit and return the finished PDF.`,
      attachments: idmlPaths.map(p => ({
        filename: path.basename(p),
        path: p,  // Streamed from disk — memory efficient
        contentType: 'application/octet-stream',
      })),
    });
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: classifySmtpError(err instanceof Error ? err : new Error(String(err))) };
  } finally {
    transporter.close();
  }
}
