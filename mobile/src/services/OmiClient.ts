import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import { Buffer } from 'buffer';

const OMI_SERVICE = '19B10000-E8F2-537E-4F6C-D104768A1214';
const OMI_AUDIO_CHAR = '19B10001-E8F2-537E-4F6C-D104768A1214';
const OMI_CODEC_CHAR = '19B10002-E8F2-537E-4F6C-D104768A1214';

type FrameHandler = (packetNo: number, payload: Uint8Array) => void;

export class OmiClient {
  private manager = new BleManager();
  private device: Device | null = null;
  private unsubscribe: (() => void) | null = null;
  private currentPacketNo: number | null = null;
  private chunkMap: Map<number, Map<number, Uint8Array>> = new Map();
  private onFrame: FrameHandler | null = null;
  private codec: number | null = null;

  async ensureAndroidPermissions() {
    if (Platform.OS !== 'android') return;
    try {
      await PermissionsAndroid.requestMultiple([
        'android.permission.BLUETOOTH_SCAN',
        'android.permission.BLUETOOTH_CONNECT',
        'android.permission.ACCESS_FINE_LOCATION',
      ] as any);
    } catch {}
  }

  async scanAndConnect(timeoutMs = 10000): Promise<Device> {
    await this.ensureAndroidPermissions();
    return new Promise((resolve, reject) => {
      const sub = this.manager.onStateChange(async (state) => {
        if (state !== 'PoweredOn') return;
        sub.remove();
        const timer = setTimeout(() => {
          try { this.manager.stopDeviceScan(); } catch {}
          reject(new Error('Scan timeout'));
        }, timeoutMs);

        // Scan broadly; match likely Omi names to support devices named "Friend (...)" or "Omi DevKit2 (...)"
        this.manager.startDeviceScan(null, { allowDuplicates: false }, async (error, dev) => {
          if (error) { clearTimeout(timer); reject(error); return; }
          if (!dev) return;
          const name = (dev.name ?? '').toLowerCase();
          const isOmiLike = name.includes('omi') || name.includes('friend') || name.includes('devkit');
          if (!isOmiLike) return;

          try { this.manager.stopDeviceScan(); } catch {}
          clearTimeout(timer);
          try {
            this.device = await dev.connect();
            try { await this.device.requestMTU(185); } catch {}
            await this.device.discoverAllServicesAndCharacteristics();
            resolve(this.device);
          } catch (e) { reject(e); }
        });
      }, true);
    });
  }

  async scanForDevices(timeoutMs = 8000, omiOnly = true): Promise<Array<{ id: string; name: string | null }>> {
    await this.ensureAndroidPermissions();
    return new Promise((resolve, reject) => {
      const results = new Map<string, { id: string; name: string | null }>();
      const sub = this.manager.onStateChange((state) => {
        if (state !== 'PoweredOn') return;
        sub.remove();
        const services = null; // scan broadly; we'll name-filter below
        const timer = setTimeout(() => {
          try { this.manager.stopDeviceScan(); } catch {}
          resolve(Array.from(results.values()));
        }, timeoutMs);
        this.manager.startDeviceScan(services as any, { allowDuplicates: false }, (error, dev) => {
          if (error) {
            clearTimeout(timer);
            try { this.manager.stopDeviceScan(); } catch {}
            reject(error);
            return;
          }
          if (!dev) return;
          const name = (dev.name ?? '').toLowerCase();
          const isOmiLike = name.includes('omi') || name.includes('friend') || name.includes('devkit');
          if (omiOnly && !isOmiLike) return;
          if (!results.has(dev.id)) {
            results.set(dev.id, { id: dev.id, name: dev.name ?? null });
          }
        });
      }, true);
    });
  }

  async connectById(deviceId: string): Promise<Device> {
    await this.ensureAndroidPermissions();
    const dev = await this.manager.connectToDevice(deviceId);
    this.device = dev;
    try { await this.device.requestMTU(185); } catch {}
    await this.device.discoverAllServicesAndCharacteristics();
    return this.device;
  }

  async readCodecType(): Promise<number> {
    if (!this.device) throw new Error('Not connected');
    const c = await this.device.readCharacteristicForService(OMI_SERVICE, OMI_CODEC_CHAR);
    this.codec = Buffer.from(c.value!, 'base64')[0];
    return this.codec!;
  }

  getCodec(): number | null { return this.codec; }

  monitorAudio(onFrame: FrameHandler) {
    if (!this.device) throw new Error('Not connected');
    this.onFrame = onFrame;
    const sub = this.device.monitorCharacteristicForService(OMI_SERVICE, OMI_AUDIO_CHAR, (err, ch: Characteristic | null) => {
      if (err || !ch?.value) return;
      const raw = Buffer.from(ch.value, 'base64'); // [pn_lo, pn_hi, idx, ...payload]
      const packetNo = raw[0] | (raw[1] << 8);
      const chunkIdx = raw[2];
      const payload = raw.subarray(3);

      if (!this.chunkMap.has(packetNo)) this.chunkMap.set(packetNo, new Map());
      this.chunkMap.get(packetNo)!.set(chunkIdx, Uint8Array.from(payload));

      if (this.currentPacketNo === null) {
        this.currentPacketNo = packetNo;
      } else if (packetNo !== this.currentPacketNo) {
        this.flush(this.currentPacketNo);
        this.currentPacketNo = packetNo;
      }
    });
    this.unsubscribe = () => sub.remove();
  }

  stopMonitoring() {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    if (this.currentPacketNo !== null) this.flush(this.currentPacketNo);
    this.currentPacketNo = null;
  }

  private flush(packetNo: number) {
    const parts = this.chunkMap.get(packetNo);
    if (!parts) return;
    const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const total = ordered.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of ordered) { out.set(p, off); off += p.length; }
    this.chunkMap.delete(packetNo);
    if (this.onFrame) this.onFrame(packetNo, out);
  }
}

export default OmiClient;


