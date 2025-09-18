import OmiClient from './OmiClient';
import { muLawToPCM16, pcm16ToWavBase64 } from './AudioUtils';

interface DeviceInfo {
  id: string;
  name: string;
  connected: boolean;
}

type EventCallback = (...args: any[]) => void;

class BLEService {
  private listeners: Map<string, EventCallback[]> = new Map();
  private omi = new OmiClient();
  private connectedDevice: DeviceInfo | null = null;
  private isStreaming = false;
  private codec: number | null = null;
  private sampleRate: number = 16000;
  private pcmBuffers: Int16Array[] = [];
  private lastFlushMs: number = Date.now();
  private flushIntervalMs: number = 4000; // accumulate ~4s of audio per upload

  // Event emitter methods
  on(event: string, callback: EventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)?.push(callback);
  }

  off(event: string, callback: EventCallback): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  emit(event: string, ...args: any[]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(callback => callback(...args));
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  async scanForDevices(): Promise<DeviceInfo[]> {
    const list = await this.omi.scanForDevices(8000, true);
    return list.map(d => ({ id: d.id, name: d.name || 'Unknown', connected: false }));
  }

  async scanAndConnect(): Promise<void> {
    console.log('[BLE] scanAndConnect tapped');
    await this.connectToDevice('omi');
  }

  async connectToDevice(_deviceId: string): Promise<void> {
    try {
      console.log('[BLE] starting scan/connect');
      const dev = await this.omi.scanAndConnect();
      this.connectedDevice = { id: dev.id, name: dev.name || 'Omi', connected: true };
      console.log('[BLE] connected to', this.connectedDevice);
      this.emit('deviceConnected', this.connectedDevice);
      this.codec = await this.omi.readCodecType();
      console.log('[BLE] codec', this.codec);
      this.sampleRate = (this.codec === 10 || this.codec === 11) ? 8000 : 16000;
      this.emit('codecChanged', this.codec);
    } catch (e) {
      console.error('[BLE] Failed to connect:', e);
      throw e;
    }
  }

  async connectToDeviceId(deviceId: string): Promise<void> {
    try {
      console.log('[BLE] connecting by id', deviceId);
      const dev = await this.omi.connectById(deviceId);
      this.connectedDevice = { id: dev.id, name: dev.name || 'Omi', connected: true };
      this.emit('deviceConnected', this.connectedDevice);
      this.codec = await this.omi.readCodecType();
      this.sampleRate = (this.codec === 10 || this.codec === 11) ? 8000 : 16000;
      this.emit('codecChanged', this.codec);
    } catch (e) {
      console.error('[BLE] Failed to connect by id:', e);
      throw e;
    }
  }

  async disconnectDevice(): Promise<void> {
    if (this.connectedDevice) {
      try {
        this.stopAudioStream();
      } finally {
        const prev = this.connectedDevice;
        this.connectedDevice = null;
        this.emit('deviceDisconnected', prev);
      }
    }
  }

  startAudioStream(): void {
    if (!this.connectedDevice?.connected) {
      throw new Error('No device connected');
    }
    if (this.isStreaming) return;
    if (this.codec === 20) {
      console.warn('Opus codec detected. Implement decoder or switch device to PCM/μ-law.');
    }

    this.isStreaming = true;
    this.pcmBuffers = [];
    this.lastFlushMs = Date.now();

    this.omi.monitorAudio((_packetNo, payload) => {
      if (!payload || payload.length === 0) return;
      if (!this.isStreaming) return;
      let pcm: Int16Array | null = null;
      if (this.codec === 10 || this.codec === 11) {
        // μ-law
        pcm = muLawToPCM16(payload);
      } else {
        // assume PCM16
        if (payload.byteLength % 2 !== 0) return; // corrupted
        pcm = new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2);
        pcm = new Int16Array(pcm); // copy to detach from underlying buffer
      }
      this.pcmBuffers.push(pcm);

      const now = Date.now();
      if (now - this.lastFlushMs >= this.flushIntervalMs) {
        this.flushBufferedPcm();
        this.lastFlushMs = now;
      }
    });

    this.emit('streamStarted');
  }

  stopAudioStream(): void {
    if (!this.isStreaming) return;
    this.isStreaming = false;
    try { this.omi.stopMonitoring(); } catch {}
    this.flushBufferedPcm();
    this.emit('streamStopped');
  }

  private flushBufferedPcm() {
    if (this.pcmBuffers.length === 0) return;
    const total = this.pcmBuffers.reduce((n, a) => n + a.length, 0);
    const joined = new Int16Array(total);
    let off = 0;
    for (const seg of this.pcmBuffers) { joined.set(seg, off); off += seg.length; }
    this.pcmBuffers = [];
    const base64Wav = pcm16ToWavBase64(joined, this.sampleRate);
    this.emit('audioChunk', { base64Wav, sampleRate: this.sampleRate, codec: this.codec });
  }

  isDeviceConnected(): boolean {
    return this.connectedDevice !== null && this.connectedDevice.connected;
  }

  isStreamActive(): boolean {
    return this.isStreaming;
  }
}

export default new BLEService();