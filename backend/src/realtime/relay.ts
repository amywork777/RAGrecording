import type { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { spawn } from 'child_process';

// AAI realtime minimal client over WS
import SupabaseService from '../services/SupabaseService';
import ZeroEntropy from 'zeroentropy';

const ConfigSchema = z.object({
  type: z.literal('config'),
  source: z.enum(['phone', 'omi']),
  encoding: z.enum(['pcm16', 'opus']),
  container: z.enum(['raw', 'ogg', 'webm']).optional(),
  sample_rate: z.number().int().positive(),
  channels: z.number().int().positive().default(1),
  frame_ms: z.number().int().positive().optional(),
  language: z.string().optional(),
  diarize: z.boolean().optional(),
  punctuate: z.boolean().optional(),
});

type StreamState = {
  sessionId: string;
  userId: string;
  source: 'phone' | 'omi';
  sampleRate: number;
  aaiWs?: WebSocket;
  ffmpeg?: ReturnType<typeof spawn>;
  configReceived: boolean;
  diarizationEnabled: boolean;
  closed: boolean;
  partialSeq: number;
  finalSeq: number;
  pcmForwarder?: (chunk: Buffer) => void;
  finals: Array<{ text: string; start_ms: number; end_ms: number; words?: any[] }>;
};

const verifyJwt = (token: string): { user_id: string; session_id: string; src: 'phone'|'omi'; sr: number } => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  const payload = jwt.verify(token, secret) as any;
  return { user_id: payload.user_id, session_id: payload.session_id, src: payload.src, sr: payload.sr };
};

const connectAAI = (sampleRate: number, diarize: boolean, onEvent: (ev: any) => void, onError: (err: any) => void) => {
  // AssemblyAI SDK supports streaming via WebSocket url retrieval; fallback to manual WS
  // Here we use raw WS per docs-compatible shape
  const realtimeUrl = `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=${sampleRate}&punctuate=true${diarize ? '&speaker_labels=true' : ''}`;
  const aaiWs = new WebSocket(realtimeUrl, { headers: { Authorization: process.env.ASSEMBLYAI_API_KEY || '' } });
  aaiWs.on('message', (msg) => {
    try { onEvent(JSON.parse(msg.toString())); } catch {}
  });
  aaiWs.on('error', onError);
  return aaiWs;
};

export function attachRealtimeRelay(server: HTTPServer) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { url = '' } = request;
    if (!url.startsWith('/ws')) {
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket, request) => {
    const params = new URLSearchParams(request.url?.split('?')[1] || '');
    const token = params.get('token');
    if (!token) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    let state: StreamState | null = null;

    try {
      const { user_id, session_id, src, sr } = verifyJwt(token);
      state = {
        sessionId: session_id,
        userId: user_id,
        source: src,
        sampleRate: sr,
        configReceived: false,
        diarizationEnabled: true,
        closed: false,
        partialSeq: 0,
        finalSeq: 0,
        finals: [],
      };
    } catch (e) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    const sendJson = (obj: any) => {
      try { ws.send(JSON.stringify(obj)); } catch {}
    };

    const closeWith = async (code: number, reason: string) => {
      try { ws.close(code, reason); } catch {}
      state?.ffmpeg?.kill('SIGKILL');
      try { state?.aaiWs?.close(); } catch {}
      // On close: persist full transcript to ZeroEntropy and end Supabase session
      try {
        if (state && state.finals.length > 0) {
          const full = state.finals.sort((a,b) => a.start_ms - b.start_ms).map(f => f.text).join(' ');
          // Optional: upload to ZE if configured
          const apiKey = process.env.ZEROENTROPY_API_KEY;
          if (apiKey && apiKey.startsWith('ze_')) {
            const base_url = (process.env.ZEROENTROPY_BASE_URL || 'https://api.zeroentropy.dev/v1').trim();
            const client = new ZeroEntropy({ apiKey, base_url } as any);
            const collection_name = 'ai-wearable-transcripts';
            const path = `mobile/live/${Date.now()}_${state.sessionId}.txt`;
            try { await client.collections.add({ collection_name } as any); } catch {}
            try {
              await client.documents.add({
                collection_name,
                path,
                content: { type: 'text', text: full },
                metadata: { timestamp: new Date().toISOString(), source: 'mobile-transcription-live', session_id: state.sessionId } as any,
              } as any);
            } catch (e) { /* swallow */ }
          }
        }
        if (state) {
          await SupabaseService.endSession(state.sessionId);
        }
      } catch {}
      state = null;
    };

    ws.on('message', (data, isBinary) => {
      if (!state || state.closed) return;

      if (!state.configReceived) {
        // Expect first message as config (text JSON)
        if (isBinary) {
          closeWith(4401, 'Expected config');
          return;
        }
        try {
          const cfg = ConfigSchema.parse(JSON.parse(data.toString()));
          state.configReceived = true;
          state.diarizationEnabled = cfg.diarize ?? true;

          // Connect AAI realtime with client's intended sample_rate (normalize to 16000 at input stage)
          const targetRate = 16000; // AAI expects 16k PCM
          const aai = connectAAI(targetRate, state.diarizationEnabled, (ev) => {
            if (ev.message_type === 'PartialTranscript') {
              const start_ms = ev.audio_start ?? 0;
              const end_ms = ev.audio_end ?? 0;
              sendJson({ type: 'partial', text: ev.text || '', start_ms, end_ms, diarization_enabled: !!ev.speaker_labels });
            } else if (ev.message_type === 'FinalTranscript') {
              const start_ms = ev.audio_start ?? 0;
              const end_ms = ev.audio_end ?? 0;
              const words = Array.isArray(ev.words) ? ev.words.map((w: any) => ({ word: w.text, start_ms: w.start, end_ms: w.end, speaker: w.speaker })) : undefined;
              const final = { type: 'final', text: ev.text || '', start_ms, end_ms, words, diarization_enabled: !!ev.speaker_labels };
              state?.finals.push({ text: final.text, start_ms, end_ms, words });
              sendJson(final);
              // Persist final segment if Supabase configured
              (async () => {
                try {
                  if (SupabaseService.isConfigured()) {
                    await SupabaseService.addFinalSegment({ session_id: state!.sessionId, start_ms, end_ms, text: final.text, words_json: words });
                  }
                } catch {}
              })();
            } else if (ev.error) {
              closeWith(4501, 'vendor error');
            }
          }, (err) => {
            closeWith(4501, 'vendor error');
          });
          state.aaiWs = aai;

          aai.on('open', async () => {
            // Start Supabase session if available
            (async () => {
              try {
                if (SupabaseService.isConfigured()) {
                  await SupabaseService.startSession({ user_id: state!.userId, source: state!.source, vendor: 'assemblyai', sample_rate: 16000 });
                }
              } catch {}
            })();
            // Install forwarder depending on encoding
            if (cfg.encoding === 'pcm16') {
              state!.pcmForwarder = (chunk: Buffer) => {
                const b64 = chunk.toString('base64');
                aai.send(JSON.stringify({ audio_data: b64 }));
              };
            } else if (cfg.encoding === 'opus') {
              const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
              const args = [
                '-loglevel', 'quiet',
                '-f', cfg.container === 'webm' ? 'webm' : (cfg.container === 'raw' ? 'opus' : 'ogg'),
                '-ar', String(cfg.sample_rate || state!.sampleRate || 48000),
                '-ac', '1',
                '-i', 'pipe:0',
                '-ar', String(targetRate),
                '-ac', '1',
                '-f', 's16le',
                'pipe:1'
              ];
              const ff = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
              state!.ffmpeg = ff;
              ff.on('error', () => closeWith(4501, 'decoder error'));
              ff.on('close', (code) => { if (!state?.closed && code !== 0) closeWith(4501, 'decoder exit'); });
              ff.stdout.on('data', (pcm: Buffer) => {
                // Split into ~20ms frames at 16k mono s16le → 16000 samples/s * 2 bytes = 32000 B/s → ~640 B per 20ms
                const frameBytes = 640;
                for (let i = 0; i < pcm.length; i += frameBytes) {
                  const slice = pcm.subarray(i, Math.min(i + frameBytes, pcm.length));
                  const b64 = slice.toString('base64');
                  aai.send(JSON.stringify({ audio_data: b64 }));
                }
              });
              state!.pcmForwarder = (chunk: Buffer) => {
                try { ff.stdin.write(chunk); } catch {}
              };
            }
          });

        } catch (e) {
          closeWith(4401, 'Bad config');
        }
        return;
      }

      // After config: binary = audio frames; text json = control
      if (isBinary) {
        if (state.pcmForwarder) state.pcmForwarder(data as Buffer);
      } else {
        try {
          const msg = JSON.parse((data as Buffer).toString());
          if (msg?.type === 'stop') {
            try { state.aaiWs?.send(JSON.stringify({ terminate_session: true })); } catch {}
            closeWith(1000, 'normal');
          }
        } catch {}
      }
    });

    ws.on('close', () => {
      if (!state) return;
      state.closed = true;
      try { state.aaiWs?.send(JSON.stringify({ terminate_session: true })); } catch {}
      try { state.aaiWs?.close(); } catch {}
      try { state.ffmpeg?.stdin?.end(); } catch {}
      try { state.ffmpeg?.kill('SIGKILL'); } catch {}
    });
  });
}


