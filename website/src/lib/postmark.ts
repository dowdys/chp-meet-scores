import "server-only";

import * as postmark from "postmark";

let _client: postmark.ServerClient | null = null;
function getClient(): postmark.ServerClient {
  if (!_client) {
    _client = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN!);
  }
  return _client;
}

const FROM_EMAIL = process.env.POSTMARK_FROM_EMAIL || "orders@thestatechampion.com";

export async function sendTransactionalEmail(
  to: string,
  subject: string,
  htmlBody: string
) {
  return getClient().sendEmail({
    From: FROM_EMAIL,
    To: to,
    Subject: subject,
    HtmlBody: htmlBody,
    MessageStream: "outbound", // Transactional stream
    TrackOpens: true,
    TrackLinks: postmark.Models.LinkTrackingOptions.HtmlAndText,
  });
}

export async function sendBroadcastEmail(
  to: string,
  subject: string,
  htmlBody: string
) {
  return getClient().sendEmail({
    From: FROM_EMAIL,
    To: to,
    Subject: subject,
    HtmlBody: htmlBody,
    MessageStream: "broadcasts", // Broadcast stream
    TrackOpens: true,
    TrackLinks: postmark.Models.LinkTrackingOptions.HtmlAndText,
  });
}

export async function sendBatchEmails(
  emails: Array<{
    to: string;
    subject: string;
    htmlBody: string;
    stream?: string;
  }>
) {
  // Postmark supports 500 per batch
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
