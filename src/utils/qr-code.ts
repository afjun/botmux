import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode') as any;
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as Record<string, unknown>;

const MARGIN_MODULES = 4;
const MODULE_SIZE = 8;

export function extractLoginUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'█▀▄]+/g)]
    .map(match => match[0].replace(/[),.;]+$/, ''));
}

/** Render a URL as a crisp, scanner-friendly QR PNG. */
export function renderQrCodePng(value: string): Buffer {
  if (!value) throw new Error('QR code value is required');

  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(value);
  qr.make();

  const moduleCount = qr.getModuleCount() as number;
  const side = (moduleCount + MARGIN_MODULES * 2) * MODULE_SIZE;
  const canvas = createCanvas(side, side);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = '#000000';

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (!qr.modules[row][col]) continue;
      ctx.fillRect(
        (col + MARGIN_MODULES) * MODULE_SIZE,
        (row + MARGIN_MODULES) * MODULE_SIZE,
        MODULE_SIZE,
        MODULE_SIZE,
      );
    }
  }

  return canvas.toBuffer('image/png');
}
