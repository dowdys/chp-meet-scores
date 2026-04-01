import "server-only";

import * as postmark from "postmark";

let _client: postmark.ServerClient | null = null;
function getClient(): postmark.ServerClient {
  if (!_client) {
    _client = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN!);
  }
  return _client;
}

const FROM_EMAIL =
  process.env.POSTMARK_FROM_EMAIL || "orders@thestatechampion.com";

const RELAY_FROM_EMAIL =
  process.env.POSTMARK_RELAY_FROM || "sales@thestatechampion.com";

interface EmailAttachment {
  filename: string;
  content: string; // base64
  contentType: string;
}

export async function sendEmail({
  to,
  subject,
  textBody,
  htmlBody,
  attachments,
  from,
  stream,
}: {
  to: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: EmailAttachment[];
  from?: string;
  stream?: string;
}) {
  const message: postmark.Models.Message = {
    From: from || RELAY_FROM_EMAIL,
    To: to,
    Subject: subject,
    MessageStream: stream || "outbound",
  };
  if (textBody) message.TextBody = textBody;
  if (htmlBody) message.HtmlBody = htmlBody;
  if (attachments && attachments.length > 0) {
    message.Attachments = attachments.map((a) => ({
      Name: a.filename,
      Content: a.content,
      ContentType: a.contentType,
      ContentID: "",
    }));
  }
  return getClient().sendEmail(message);
}

export async function sendBatchEmails(
  emails: Array<{
    to: string;
    subject: string;
    htmlBody: string;
    stream?: string;
  }>
) {
  const BATCH_SIZE = 500;
  const results: postmark.Models.MessageSendingResponse[] = [];

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE).map((e) => ({
      From: FROM_EMAIL,
      To: e.to,
      Subject: e.subject,
      HtmlBody: e.htmlBody,
      MessageStream: e.stream || "outbound",
    }));
    const result = await getClient().sendEmailBatch(batch);
    results.push(...result);
  }

  return results;
}
