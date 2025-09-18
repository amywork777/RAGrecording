// Simple audio utilities: mu-law to PCM16 and PCM16 to WAV (base64)

export function muLawToPCM16(src: Uint8Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const u = ~src[i] & 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t <<= ((u & 0x70) >> 4);
    out[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
  }
  return out;
}

export function pcm16ToWavBase64(pcm: Int16Array, sampleRate: number = 16000): string {
  const numSamples = pcm.length;
  const blockAlign = 2; // mono 16-bit
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, 1, true);  // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  const dst = new Int16Array(buffer, 44);
  dst.set(pcm);

  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if ((global as any).btoa) return (global as any).btoa(bin);
  // Fallback for environments without btoa
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Buffer } = require('buffer');
  return Buffer.from(bytes).toString('base64');
}


