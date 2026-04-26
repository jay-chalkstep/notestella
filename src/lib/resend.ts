import { Resend } from 'resend';

let cachedClient: Resend | null = null;
function getClient(): Resend {
  if (!cachedClient) cachedClient = new Resend(process.env.RESEND_API_KEY);
  return cachedClient;
}

export async function sendPdfsToRemarkable(
  pdfs: { filename: string; buffer: Buffer }[],
  subject: string
): Promise<void> {
  const fromAddress = process.env.RESEND_FROM_ADDRESS;
  const to = process.env.REMARKABLE_EMAIL;
  if (!fromAddress) throw new Error('RESEND_FROM_ADDRESS not set');
  if (!to) throw new Error('REMARKABLE_EMAIL not set');

  // Display-name format renders as "Notestella <addr>" in client UIs. The body
  // lists each attachment so a missed-delivery investigation in the email web
  // UI can confirm what was supposed to land on the tablet.
  const from = `Notestella <${fromAddress}>`;
  const body = pdfs.length === 0
    ? subject
    : `${subject}\n\nAttached:\n${pdfs.map((p) => `- ${p.filename}`).join('\n')}`;

  const { error } = await getClient().emails.send({
    from,
    to,
    subject,
    text: body,
    attachments: pdfs.map((p) => ({
      filename: p.filename,
      content: p.buffer,
    })),
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }
}
