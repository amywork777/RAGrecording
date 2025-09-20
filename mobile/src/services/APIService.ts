import Constants from 'expo-constants';
import { Platform } from 'react-native';

function deriveDefaultBaseUrl(): string {
  // 1) Respect explicit config if provided
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL;
  }

  // 2) Try to infer host from Expo (works in Expo Go and dev builds)
  try {
    const anyConstants: any = Constants as any;
    const hostUri: string | undefined =
      anyConstants?.expoConfig?.hostUri ||
      anyConstants?.manifest2?.extra?.expoGo?.hostUri ||
      anyConstants?.manifest?.debuggerHost;
    if (hostUri && typeof hostUri === 'string') {
      const host = hostUri.split(':')[0];
      return `http://${host}:3000`;
    }
  } catch {}

  // 3) Platform-specific dev fallbacks
  if (Platform.OS === 'android') {
    // Android emulator special alias for host-loopback
    return 'http://10.0.2.2:3000';
  }
  // iOS simulator / generic fallback
  return 'http://localhost:3000';
}

const API_BASE_URL = deriveDefaultBaseUrl();
export const API_BASE = API_BASE_URL;
// Helpful log to verify at runtime
// eslint-disable-next-line no-console
console.log('API base URL:', API_BASE_URL);

interface TranscriptionResponse {
  transcription: string;
  title?: string;
  summary?: string;
  recordingId: string;
  timestamp: string;
  // AssemblyAI may return transcription with speaker labels
  hasDiarization?: boolean;
}

interface SearchResult {
  id: string;
  text: string;
  timestamp: string;
  recordingId: string;
  score: number;
}

interface SearchResponse {
  results: SearchResult[];
  answer?: string;
  sources?: Array<{
    text: string;
    timestamp: string;
    topic: string;
    score: number;
  }>;
}

class APIService {
  async sendAudioBase64(base64Audio: string, recordingId: string, format: string = 'm4a'): Promise<TranscriptionResponse> {
    const formData = new FormData();
    
    // Create a file-like object from base64
    const mimeType = format === 'wav' ? 'audio/wav' : 'audio/m4a';
    const filename = format === 'wav' ? 'recording.wav' : 'recording.m4a';
    
    formData.append('audio', {
      uri: `data:${mimeType};base64,${base64Audio}`,
      type: mimeType,
      name: filename,
    } as any);
    formData.append('recordingId', recordingId);

    const response = await fetch(`${API_BASE_URL}/api/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Transcription failed: ${response.statusText}`);
    }

    return response.json();
  }

  async searchTranscripts(query: string): Promise<SearchResponse> {
    // Try ZeroEntropy + GPT search first
    try {
      const response = await fetch(`${API_BASE_URL}/api/zeroentropy/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          query,
          limit: 5,
          useGPT: true 
        }),
      });

      if (response.ok) {
        const data = await response.json();
        console.log('Using ZeroEntropy + GPT search');
        return data;
      }
    } catch (error) {
      console.log('ZeroEntropy search failed, falling back to regular search');
    }

    // Fallback to regular search
    const response = await fetch(`${API_BASE_URL}/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.statusText}`);
    }

    return response.json();
  }

  async getRecentTranscripts(limit: number = 50): Promise<any[]> {
    // Prefer Supabase as source of truth for UI
    try {
      const response = await fetch(`${API_BASE_URL}/api/supabase/recent?limit=${limit}`, {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (response.ok) {
        const data = await response.json();
        console.log(`Fetched ${data.count} documents from Supabase`);
        return data.documents || [];
      }
    } catch (error) {
      console.log('Supabase fetch failed, falling back to ZE');
    }

    // Fallback to ZE if Supabase unavailable
    try {
      const response = await fetch(`${API_BASE_URL}/api/zeroentropy/documents?limit=${limit}`, {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (response.ok) {
        const data = await response.json();
        console.log(`Fetched ${data.count} documents from ZeroEntropy (fallback)`);
        return data.documents || [];
      }
    } catch {}

    // Last resort: mock
    const response = await fetch(`${API_BASE_URL}/api/transcripts/recent?limit=${limit}`, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch recent transcripts: ${response.statusText}`);
    }
    return response.json();
  }

  async getDocumentByPath(path: string, collectionName: string = 'ai-wearable-transcripts'): Promise<any> {
    const url = `${API_BASE_URL}/api/zeroentropy/document-by-path?path=${encodeURIComponent(path)}&collection_name=${encodeURIComponent(collectionName)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch document by path: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async uploadTextDocument(
    text: string,
    options?: { path?: string; metadata?: Record<string, any>; collectionName?: string }
  ): Promise<any> {
    const body: any = {
      text,
    };
    if (options?.path) body.path = options.path;
    if (options?.metadata) body.metadata = options.metadata;
    if (options?.collectionName) body.collection_name = options.collectionName;

    const response = await fetch(`${API_BASE_URL}/api/zeroentropy/upload-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Failed to upload document: ${response.statusText}`);
    }

    return response.json();
  }

  async deleteDocument(path: string, collectionName: string = 'ai-wearable-transcripts'): Promise<any> {
    const response = await fetch(`${API_BASE_URL}/api/zeroentropy/delete-document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, collection_name: collectionName }),
    });
    if (!response.ok) {
      throw new Error(`Failed to delete document: ${response.statusText}`);
    }
    return response.json();
  }

  async generateSummary(text: string): Promise<string> {
    const response = await fetch(`${API_BASE_URL}/api/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      throw new Error(`Failed to generate summary: ${response.statusText}`);
    }
    const data = await response.json();
    return data?.summary || '';
  }

  async generateTitleAndSummary(text: string): Promise<{ title: string; summary: string }> {
    const response = await fetch(`${API_BASE_URL}/api/title-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      throw new Error(`Failed to generate title/summary: ${response.statusText}`);
    }
    return response.json();
  }
}

export default new APIService();