import OpenAI from 'openai';
import { AssemblyAI } from 'assemblyai';
import fs from 'fs';
import path from 'path';

class TranscriptionService {
  private openai: OpenAI | null = null;
  private assemblyai: AssemblyAI;

  constructor() {
    // Delay OpenAI client creation until actually used to avoid crashing when key is missing
    // AssemblyAI for audio transcription + diarization (audio-based speaker detection)
    this.assemblyai = new AssemblyAI({
      apiKey: process.env.ASSEMBLYAI_API_KEY || '',
    });
  }

  private getOpenAI(): OpenAI {
    if (this.openai) return this.openai;
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OPENAI_API_KEY missing');
    }
    this.openai = new OpenAI({ apiKey: key });
    return this.openai;
  }

  // Main entry: first non-diarized pass → LLM classify (single vs multi) →
  // if multi, re-run with diarization (plus smoothing); finally generate title/summary.
  async transcribeAudio(audioBuffer: Buffer, format: string = 'wav', speakersExpected: number = 2): Promise<{transcription: string; title?: string; summary?: string}> {
    try {
      let transcription: string;
      
      if (process.env.ASSEMBLYAI_API_KEY) {
        // 1) Non-diarized transcript (fast, stable)
        const plainTranscript = await this.transcribeWithAssemblyAIPlain(audioBuffer, format);
        // 2) Text-only classifier (heuristic routing hint, not authoritative)
        const isMulti = await this.classifySingleVsMulti(plainTranscript);
        // 3) Only run diarization if multi-person likely
        if (isMulti) {
          transcription = await this.transcribeWithAssemblyAI(audioBuffer, format, Math.max(2, speakersExpected));
        } else {
          transcription = plainTranscript;
        }
      } else {
        // Fallback path using Whisper if no AssemblyAI key
        transcription = await this.transcribeWithWhisper(audioBuffer, format);
      }
      
      // LLM title/summary (user-facing)
      const { title, summary } = await this.generateTitleAndSummary(transcription);
      
      return { transcription, title, summary };
    } catch (error: any) {
      console.error('Error transcribing audio:', error);
      console.error('Error details:', error.message, error.status);
      
      const transcription = this.getSimulatedTranscription();
      return { transcription, title: 'Untitled Recording', summary: 'Failed to generate summary.' };
    }
  }

  // AssemblyAI non-diarized transcription for stable single-speaker routing
  private async transcribeWithAssemblyAIPlain(audioBuffer: Buffer, format: string = 'wav'): Promise<string> {
    const tempDir = process.env.TMPDIR || '/tmp';
    try { if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir); } catch {}

    const fileExt = format === 'wav' ? 'wav' : 'm4a';
    const tempFilePath = path.join(tempDir, `audio_${Date.now()}.${fileExt}`);
    fs.writeFileSync(tempFilePath, audioBuffer);

    try {
      const transcript = await this.assemblyai.transcripts.transcribe({
        audio: tempFilePath,
        speaker_labels: false,
      });
      return transcript.text || '';
    } finally {
      try { fs.unlinkSync(tempFilePath); } catch {}
    }
  }

  // AssemblyAI diarized transcription with backend smoothing for flip-flops
  private async transcribeWithAssemblyAI(
    audioBuffer: Buffer,
    format: string = 'wav',
    speakersExpected?: number
  ): Promise<string> {
    try {
      console.log(`Transcribing with AssemblyAI (diarized), size: ${audioBuffer.length}, speakersExpected: ${speakersExpected ?? 'auto'}`);
      
      const tempDir = process.env.TMPDIR || '/tmp';
      try { if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir); } catch {}
      
      const fileExt = format === 'wav' ? 'wav' : 'm4a';
      const tempFilePath = path.join(tempDir, `audio_${Date.now()}.${fileExt}`);
      fs.writeFileSync(tempFilePath, audioBuffer);

      // Only set speakers_expected when caller provided a hint; otherwise let AAI infer.
      const requestBody: any = {
        audio: tempFilePath,
        speaker_labels: true,
      };
      if (typeof speakersExpected === 'number' && speakersExpected > 0) {
        requestBody.speakers_expected = speakersExpected;
      }
      const firstPass = await this.assemblyai.transcripts.transcribe(requestBody);

      // Smoothing: duration-based dominance, short flip absorption, adjacent merge
      if (firstPass.utterances && firstPass.utterances.length > 0) {
        const utterances: any[] = firstPass.utterances as any[];
        const uniqueSpeakers = new Set(utterances.map(u => u.speaker));
        const durBySpeaker = new Map<number, number>();
        const segDurations: number[] = [];
        for (const u of utterances) {
          const durSec = Math.max(0, ((u.end ?? 0) - (u.start ?? 0)) / 1000);
          segDurations.push(durSec);
          durBySpeaker.set(u.speaker, (durBySpeaker.get(u.speaker) || 0) + durSec);
        }
        const totalDur = Array.from(durBySpeaker.values()).reduce((a, b) => a + b, 0);
        const maxDur = totalDur > 0 ? Math.max(...Array.from(durBySpeaker.values())) : 0;
        const dominantDurRatio = totalDur > 0 ? maxDur / totalDur : 1;
        let switches = 0;
        for (let i = 1; i < utterances.length; i++) {
          if (utterances[i].speaker !== utterances[i - 1].speaker) switches++;
        }
        const sortedDur = segDurations.slice().sort((a, b) => a - b);
        const medianDur = sortedDur.length ? sortedDur[Math.floor(sortedDur.length / 2)] : 0;

        // Collapse to single-speaker when one dominates
        if (uniqueSpeakers.size <= 1 || dominantDurRatio >= 0.8) {
          const single = utterances.map(u => u.text).join(' ');
          try { fs.unlinkSync(tempFilePath); } catch {}
          return single || (firstPass.text || '');
        }

        // Fallback to non-diarized when flip-flops are excessive and segments are very short
        if (switches >= 3 && medianDur < 1.5) {
          try {
            const secondPass = await this.assemblyai.transcripts.transcribe({ audio: tempFilePath, speaker_labels: false });
            try { fs.unlinkSync(tempFilePath); } catch {}
            return (secondPass.text || utterances.map(u => u.text).join(' '));
          } catch {}
        }

        // Merge adjacent same-speaker segments and absorb <1.2s flips
        const minFlipDur = 1.2;
        const merged: Array<{ speaker: number; text: string; dur: number }> = [];
        for (const u of utterances) {
          const durSec = Math.max(0, ((u.end ?? 0) - (u.start ?? 0)) / 1000);
          const last = merged[merged.length - 1];
          if (last && last.speaker === u.speaker) {
            last.text = `${last.text} ${u.text}`.trim();
            last.dur += durSec;
          } else if (last && last.speaker !== u.speaker && durSec < minFlipDur) {
            last.text = `${last.text} ${u.text}`.trim();
            last.dur += durSec;
          } else {
            merged.push({ speaker: u.speaker, text: (u.text || '').trim(), dur: durSec });
          }
        }
        const formattedText = merged.map(seg => `Speaker ${seg.speaker}: ${seg.text}`).join('\n');
        try { fs.unlinkSync(tempFilePath); } catch {}
        return formattedText;
      }

      try { fs.unlinkSync(tempFilePath); } catch {}
      return firstPass.text || '';
    } catch (error) {
      console.error('AssemblyAI transcription failed:', error);
      throw error;
    }
  }

  // Active Whisper fallback method
  private async transcribeWithWhisper(audioBuffer: Buffer, format: string = 'wav'): Promise<string> {
    try {
      const tempDir = process.env.TMPDIR || '/tmp';
      try { if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir); } catch {}
      const fileExt = format === 'wav' ? 'wav' : 'm4a';
      const tempFilePath = path.join(tempDir, `audio_${Date.now()}.${fileExt}`);
      fs.writeFileSync(tempFilePath, audioBuffer);

      const openai = this.getOpenAI();
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: 'whisper-1',
        language: 'en',
      });

      try { fs.unlinkSync(tempFilePath); } catch {}
      return transcription.text;
    } catch (error: any) {
      console.error('Error transcribing audio with Whisper:', error);
      throw error;
    }
  }

  private getSimulatedTranscription(): string {
    const simulatedTexts = [
      "Let's discuss the roadmap for the next quarter and align on priorities.",
      "The user interface needs to be more intuitive based on the feedback we received.",
      "We should focus on improving the search functionality and response time.",
      "Remember to follow up with the team about the deployment schedule.",
      "The integration with the third-party API is working as expected now.",
    ];

    return simulatedTexts[Math.floor(Math.random() * simulatedTexts.length)];
  }

  async transcribeChunks(chunks: Buffer[]): Promise<{transcription: string; title?: string; summary?: string}> {
    const combinedBuffer = Buffer.concat(chunks);
    return this.transcribeAudio(combinedBuffer);
  }

  // LLM title/summary generation for UI
  private async generateTitleAndSummary(transcription: string): Promise<{title: string; summary: string}> {
    try {
      if (transcription.length < 50) {
        return { title: 'Brief Note', summary: transcription.substring(0, 100) };
      }
      const openai = this.getOpenAI();
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that creates concise titles and summaries for transcribed conversations or notes.' },
          { role: 'user', content: `Based on the following transcription, generate:\n1. A short, descriptive title (max 50 characters)\n2. A 2-3 sentence summary highlighting the key points\n\nTranscription:\n${transcription.substring(0, 3000)} // Limit context to save tokens\n\nPlease respond in the following JSON format:\n{\n  "title": "Your title here",\n  "summary": "Your 2-3 sentence summary here"\n}` },
        ],
        temperature: 0.7,
        max_tokens: 200,
        response_format: { type: "json_object" },
      });
      const response = completion.choices[0].message.content;
      if (response) {
        const parsed = JSON.parse(response);
        return { title: parsed.title || 'Untitled', summary: parsed.summary || 'No summary available.' };
      }
      return { title: 'Untitled Recording', summary: 'Unable to generate summary.' };
    } catch (error) {
      console.error('Error generating title and summary:', error);
      const firstLine = transcription.split('\n')[0];
      const title = firstLine.substring(0, 50).trim() || 'Untitled Recording';
      const words = transcription.split(' ');
      const summary = words.slice(0, 50).join(' ') + (words.length > 50 ? '...' : '');
      return { title, summary };
    }
  }

  // Text-only classifier to hint whether diarization is needed
  private async classifySingleVsMulti(text: string): Promise<boolean> {
    try {
      if (!text || text.trim().length < 50) return false; // short content → likely single
      const openai = this.getOpenAI();
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        temperature: 0,
        max_tokens: 10,
        messages: [
          { role: 'system', content: 'Classify if the transcript is spoken by a single person or multiple. Reply with exactly one word: single or multi.' },
          { role: 'user', content: text.slice(0, 2000) },
        ],
      });
      const answer = (completion.choices[0].message.content || '').toLowerCase();
      return answer.includes('multi');
    } catch (e) {
      console.warn('Speaker classification failed, defaulting to single:', (e as any)?.message || e);
      return false;
    }
  }
}

export default new TranscriptionService();