import QRCode from 'qrcode';

export async function generateQrDataUrl(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  return QRCode.toDataURL(json, { errorCorrectionLevel: 'M', margin: 1, scale: 4 });
}
