import { describe, expect, it } from 'vitest';
import { extractLoginUrls, renderQrCodePng } from '../src/utils/qr-code.js';

describe('renderQrCodePng', () => {
  it('renders a square PNG from a login URL', () => {
    const png = renderQrCodePng('https://example.com/login?code=abc');

    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20));
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(200);
  });

  it('stops a login URL before an adjacent terminal QR', () => {
    expect(extractLoginUrls(
      'visit: https://example.com/login?code=abc&source=cli%2F1.0▄▄▄▄▄▄▄  ▄▄',
    )).toEqual(['https://example.com/login?code=abc&source=cli%2F1.0']);
  });
});
