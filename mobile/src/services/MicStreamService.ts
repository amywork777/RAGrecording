// Lightweight wrapper around react-native-audio-record
// Streams PCM16 16k mono frames via a callback for realtime WS
import { decode as atob } from 'base-64';

type OnPcmCallback = (pcm16: Uint8Array) => void;

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i) & 0xff;
  }
  return bytes;
}

class MicStreamService {
  private recording: any = null;
  private isActive: boolean = false;
  private onPcm: OnPcmCallback | null = null;

  async start(onPcm: OnPcmCallback, sampleRate: number = 16000): Promise<void> {
    if (this.isActive) return;
    this.onPcm = onPcm;
    try {
      // Dynamic require to avoid build-time type issues if module not present in dev
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AudioRecord = require('react-native-audio-record');

      AudioRecord.init({
        sampleRate, // 16k mono PCM16
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6, // Voice Recognition on Android
      });

      AudioRecord.on('data', (data: string) => {
        if (!this.isActive || !this.onPcm) return;
        try {
          // data is base64-encoded PCM16LE
          const bytes = base64ToUint8Array(data);
          this.onPcm(bytes);
        } catch {}
      });

      await AudioRecord.start();
      this.recording = AudioRecord;
      this.isActive = true;
    } catch (e) {
      console.warn('MicStreamService start failed. Is react-native-audio-record installed?', e);
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.isActive || !this.recording) return;
    try {
      await this.recording.stop();
    } catch {}
    this.recording = null;
    this.isActive = false;
    this.onPcm = null;
  }
}

export default new MicStreamService();


