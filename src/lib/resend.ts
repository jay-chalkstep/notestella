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
  const from = process.env.RESEND_FROM_ADDRESS;
  const to = process.env.REMARKABLE_EMAIL;
  if (!from) throw new Error('RESEND_FROM_ADDRESS not set');
  if (!to) throw new Error('REMARKABLE_EMAIL not set');

  const { error } = await getClient().emails.send({
    from,
    to,
    subject,
    text: subject,
    attachments: pdfs.map((p) => ({
      filename: p.filename,
      content: p.buffer,
    })),
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }
}
