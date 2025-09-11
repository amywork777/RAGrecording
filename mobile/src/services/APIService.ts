import Constants from 'expo-constants';
import { Platform } from 'react-native';

function deriveDefaultBaseUrl(): string {
  // NEW WORKING BACKEND URL - Fixed deployment with transcription fix and ZeroEntropy path fix
  const PRODUCTION_URL = 'https://backend-henna-tau-11.vercel.app';
  
  console.log('=== API URL DERIVATION DEBUG ===');
  console.log('process.env.EXPO_PUBLIC_API_URL:', process.env.EXPO_PUBLIC_API_URL);
  console.log('Constants.executionEnvironment:', Constants.executionEnvironment);
  console.log('Constants.appOwnership:', Constants.appOwnership);
  console.log('__DEV__:', __DEV__);
  
  // 1) FORCE CORRECT BACKEND - Override environment variable that's pointing to wrong URL
  console.log('FORCED: Using correct working backend URL');
  return PRODUCTION_URL;
  
  // 1) Respect explicit config if provided (DISABLED - env var has wrong URL)
  // if (process.env.EXPO_PUBLIC_API_URL) {
  //   console.log('Using EXPO_PUBLIC_API_URL:', process.env.EXPO_PUBLIC_API_URL);
  //   return process.env.EXPO_PUBLIC_API_URL;
  // }

  // 2) For production builds (TestFlight/App Store) - EXPANDED CONDITIONS
  if (Constants.executionEnvironment === 'storeClient' || 
      Constants.executionEnvironment === 'standalone' ||
      Constants.appOwnership === 'standalone' ||
      !__DEV__) {
    console.log('Using PRODUCTION_URL due to build environment:', PRODUCTION_URL);
    return PRODUCTION_URL;
  }

  // 3) For development - use Metro host IP for backend
  try {
    const anyConstants: any = Constants as any;
    const hostUri: string | undefined =
      anyConstants?.expoConfig?.hostUri ||
      anyConstants?.manifest2?.extra?.expoGo?.hostUri ||
      anyConstants?.manifest?.debuggerHost;
    
    if (hostUri && typeof hostUri === 'string') {
      const host = hostUri.split(':')[0];
      console.log('Detected Metro host:', host);
      // Use the same network IP as Metro for backend
      return `http://${host}:3000`;
    }
  } catch (error) {
    console.log('Failed to detect Metro host:', error);
  }

  // 5) Fallback to localhost for development
  console.log('Using localhost fallback');
  return 'http://localhost:3000';
}

const API_BASE_URL = deriveDefaultBaseUrl();
// Helpful log to verify at runtime
// eslint-disable-next-line no-console
console.log('API base URL:', API_BASE_URL);
// eslint-disable-next-line no-console
console.log('Execution environment:', Constants.executionEnvironment);
// eslint-disable-next-line no-console
console.log('App ownership:', Constants.appOwnership);
// eslint-disable-next-line no-console
console.log('__DEV__:', __DEV__);

// Fallback URL helper
async function fetchWithFallback(url: string, options: RequestInit): Promise<Response> {
  const PRODUCTION_URL = 'https://backend-henna-tau-11.vercel.app';
  const LOCAL_URL = 'http://localhost:3000';
  
  try {
    console.log(`Trying primary URL: ${url}`);
    const response = await fetch(url, options);
    if (response.ok) return response;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.log(`Primary URL failed: ${error.message}`);
    
    // Try fallback URL if different from primary
    const primaryBaseUrl = url.split('/api')[0];
    let fallbackUrl;
    
    if (primaryBaseUrl.includes('localhost')) {
      fallbackUrl = url.replace(LOCAL_URL, PRODUCTION_URL);
    } else {
      fallbackUrl = url.replace(PRODUCTION_URL, LOCAL_URL);
    }
    
    if (fallbackUrl !== url) {
      console.log(`Trying fallback URL: ${fallbackUrl}`);
      return await fetch(fallbackUrl, options);
    }
    
    throw error;
  }
}

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
  // Additional fields for titles and summaries
  title?: string;
  summary?: string;
  aiTitle?: string;
  aiSummary?: string;
  path?: string;
  source?: string;
  audioUrl?: string;
  durationSeconds?: number;
  duration_seconds?: number;
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
    console.log('APIService: Sending audio to transcribe endpoint');
    console.log('Recording ID:', recordingId);
    console.log('Format:', format);
    console.log('Base64 length:', base64Audio.length);
    console.log('API URL:', `${API_BASE_URL}/api/transcribe`);
    
    const formData = new FormData();
    
    // Create a file-like object from base64
    const mimeType = format === 'wav' ? 'audio/wav' : 'audio/m4a';
    const filename = format === 'wav' ? 'recording.wav' : 'recording.m4a';
    
    console.log('Creating FormData with:', { mimeType, filename });
    
    // Convert base64 to proper file format for React Native
    // Using proper blob-like structure that React Native FormData can handle
    formData.append('audio', {
      uri: `data:${mimeType};base64,${base64Audio}`,
      type: mimeType,
      name: filename,
    } as any);
    formData.append('recordingId', recordingId);

    console.log('Making fetch request...');
    const response = await fetchWithFallback(`${API_BASE_URL}/api/transcribe`, {
      method: 'POST',
      body: formData,
      headers: {
        // Let React Native set Content-Type automatically for FormData
        // Don't set Content-Type manually for multipart/form-data
      },
    });

    console.log('Response status:', response.status);
    console.log('Response headers:', response.headers);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Transcription failed:', errorText);
      throw new Error(`Transcription failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const jsonResponse = await response.json();
    console.log('Transcription response:', jsonResponse);
    return jsonResponse;
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

  async getRecentTranscripts(limit: number = 10): Promise<SearchResult[]> {
    // Use the transcriptions endpoint that was added in recent commits
    console.log(`Fetching recent transcripts from: ${API_BASE_URL}/api/transcriptions`);
    const response = await fetch(`${API_BASE_URL}/api/transcriptions?limit=${limit}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch recent transcripts: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`✅ Fetched ${data.transcriptions?.length || 0} transcripts from backend`);
    
    // Transform the backend response to match the expected SearchResult format
    const transcriptions = data.transcriptions || [];
    const results: SearchResult[] = transcriptions.map((t: any) => {
      console.log(`Processing transcript ${t.id}:`, {
        hasTranscription: !!t.transcription,
        hasText: !!t.text,
        hasTitle: !!t.title,
        hasSummary: !!t.summary,
        aiTitle: t.aiTitle,
        aiSummary: t.aiSummary,
      });
      
      return {
        id: t.id,
        text: t.transcription || t.text || '[No content]',
        timestamp: t.timestamp,
        recordingId: t.recordingId || t.id,
        score: t.score || 1.0,
        // Include all the title and summary fields
        title: t.title || t.aiTitle,
        summary: t.summary || t.aiSummary,
        aiTitle: t.aiTitle || t.title,
        aiSummary: t.aiSummary || t.summary,
        path: t.path,
        source: t.source || 'backend',
        audioUrl: t.audioUrl,
        durationSeconds: t.durationSeconds || t.duration_seconds,
      };
    });
    
    console.log(`✅ Transformed ${results.length} transcriptions for mobile app`);
    return results;
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

  async transcribeAudio(formData: FormData): Promise<any> {
    console.log('APIService: Transcribing audio file via FormData');
    
    const response = await fetchWithFallback(`${API_BASE_URL}/api/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Transcription failed:', errorText);
      throw new Error(`Transcription failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    console.log('Transcription result:', result);
    
    // Transform backend response to match expected format
    return {
      text: result.transcription || result.text || '[No speech detected]',
      aiTitle: result.title,
      aiSummary: result.summary,
      durationSeconds: result.durationSeconds,
      path: result.recordingId,
    };
  }

  async chatWithTranscription(transcriptionId: string, message: string, transcriptContent?: string): Promise<{ answer: string; transcriptionId: string; metadata: any }> {
    console.log('=== TRANSCRIPT CHAT DEBUG ===');
    console.log('Transcription ID:', transcriptionId);
    console.log('User message:', message);
    console.log('Has transcript content:', !!transcriptContent);
    
    // Try the dedicated transcription chat endpoint first
    try {
      console.log('Trying dedicated chat endpoint...');
      const response = await fetch(`${API_BASE_URL}/api/chat/transcription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcriptionId, message }),
      });
      
      if (response.ok) {
        const result = await response.json();
        console.log('Chat endpoint successful:', result);
        return result;
      } else {
        console.log('Dedicated endpoint failed, using transcript-focused approach...');
      }
    } catch (error) {
      console.log('Dedicated endpoint error, using transcript-focused approach:', error.message);
    }
    
    // Transcript-focused approach: Work with the specific transcript content only
    if (transcriptContent) {
      console.log('Using provided transcript content for conversation');
      const conversationalAnswer = await this.generateConversationalResponse(message, transcriptContent);
      return {
        answer: conversationalAnswer,
        transcriptionId,
        metadata: { source: 'transcript-focused', hasContent: true }
      };
    } else {
      // If we don't have the transcript content, we need to get it somehow
      console.log('No transcript content provided, need to retrieve it');
      return {
        answer: `I'd love to chat about this transcript, but I don't have access to its content right now. Try refreshing or selecting the transcript again!`,
        transcriptionId,
        metadata: { source: 'no-content-available' }
      };
    }
  }
  
  private async generateConversationalResponse(question: string, transcriptContent: string): Promise<string> {
    // Try to use AI to analyze the specific transcript content for better responses
    console.log('Generating AI-powered conversational response for:', question);
    console.log('Based on transcript:', transcriptContent.substring(0, 50) + '...');
    
    // First try to get AI analysis of this specific transcript
    try {
      const aiPrompt = this.createSmartPrompt(question, transcriptContent);
      console.log('Using AI prompt:', aiPrompt.substring(0, 100) + '...');
      
      const response = await fetch(`${API_BASE_URL}/api/zeroentropy/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          query: aiPrompt,
          limit: 1,
          useGPT: true 
        }),
      });

      if (response.ok) {
        const aiResponse = await response.json();
        if (aiResponse.answer && aiResponse.answer.length > 20) {
          console.log('AI generated intelligent response:', aiResponse.answer);
          return aiResponse.answer;
        }
      }
      
      console.log('AI response not good enough, using fallback');
    } catch (error) {
      console.log('AI failed, using conversational fallback:', error);
    }
    
    // Fallback to smart conversational response
    return this.generateConversationalFallback(question, transcriptContent);
  }
  
  private createSmartPrompt(question: string, transcriptContent: string): string {
    const questionLower = question.toLowerCase();
    
    if (questionLower.includes('who')) {
      return `I have a transcript that says: "${transcriptContent}". The user is asking "Who" - they want to know about people mentioned, or who might be speaking, or who this relates to. Give a conversational, helpful response based on what's actually in this transcript. Be engaging and reference the actual content.`;
    } else if (questionLower.includes('what')) {
      return `Looking at this transcript: "${transcriptContent}", the user asks "${question}". Analyze what's actually being discussed and give a natural, conversational response about the content. Be engaging and insightful about what they recorded.`;
    } else if (questionLower.includes('why') || questionLower.includes('how')) {
      return `In this recording, the user said: "${transcriptContent}". They're asking "${question}". Have a thoughtful conversation about the content, exploring the reasoning or methods based on what's actually in the transcript.`;
    } else if (questionLower.includes('hi') || questionLower.includes('hello') || questionLower.includes('chat')) {
      return `The user wants to chat about their recording where they said: "${transcriptContent}". Greet them warmly and start an engaging conversation about what they recorded. Ask interesting questions about their content.`;
    } else if (questionLower.includes('tell me more') || questionLower.includes('elaborate')) {
      return `Based on this transcript: "${transcriptContent}", the user wants more information. Expand on the content thoughtfully, ask follow-up questions, and encourage deeper discussion about what they recorded.`;
    } else if (questionLower.includes('summarize') || questionLower.includes('summary')) {
      return `Please provide an engaging, conversational summary of this transcript: "${transcriptContent}". Make it interesting and highlight key points in a natural way.`;
    } else {
      return `You're having a conversation with someone about their recording. They said: "${transcriptContent}" and now they're asking: "${question}". Respond naturally and conversationally, always referencing their actual content and being helpful and engaging.`;
    }
  }
  
  private generateConversationalFallback(question: string, transcriptContent: string): string {
    const questionLower = question.toLowerCase();
    
    // Extract key topics or interesting parts from the transcript
    const words = transcriptContent.toLowerCase().split(/\s+/);
    const interestingWords = words.filter(word => 
      word.length > 3 && 
      !['hello', 'yeah', 'okay', 'like', 'just', 'well', 'that', 'this', 'with', 'have', 'been', 'they', 'were'].includes(word)
    );
    
    const hasInterestingContent = interestingWords.length > 0;
    const isShortRecording = transcriptContent.length < 50;
    
    if (questionLower.includes('hello') || questionLower.includes('hi') || questionLower.includes('chat')) {
      if (hasInterestingContent) {
        const topics = interestingWords.slice(0, 3).join(', ');
        return `Hey! I see you mentioned ${topics} in this recording. What would you like to chat about? I can help you explore any of these topics or discuss other aspects of what you recorded.`;
      } else {
        return `Hi there! I see this was a short recording. Want to chat about what you were testing or thinking about when you made it?`;
      }
    }
    
    if (questionLower.includes('what') && questionLower.includes('think')) {
      if (isShortRecording) {
        return `Looking at what you said: "${transcriptContent}" - it seems like you were doing a quick test or note. What were you thinking about when you recorded this? Was there something specific you wanted to capture?`;
      } else {
        return `From what you recorded, it sounds like you had some interesting thoughts. What stands out to you most about what you said? I'd love to hear your perspective on it.`;
      }
    }
    
    if (questionLower.includes('why')) {
      return `That's a great question! Based on what you said in the recording: "${transcriptContent.length > 100 ? transcriptContent.substring(0, 100) + '...' : transcriptContent}" - what do you think motivated those thoughts? I'm curious about your perspective.`;
    }
    
    if (questionLower.includes('tell me more') || questionLower.includes('elaborate')) {
      return `I'd love to hear more! In your recording you mentioned: "${transcriptContent.length > 100 ? transcriptContent.substring(0, 100) + '...' : transcriptContent}" - what else were you thinking about this topic? Any other thoughts that didn't make it into the recording?`;
    }
    
    // Default conversational response
    if (hasInterestingContent) {
      return `Interesting! In your recording, you talked about ${interestingWords.slice(0, 2).join(' and ')}. How does that relate to what you're asking about? I'm here to chat about any aspect of your recording.`;
    } else {
      return `I hear you saying: "${transcriptContent}" - want to chat about what was on your mind when you recorded this? I'm curious to learn more about your thoughts.`;
    }
  }
  
  private generateContextualResponse(question: string, transcriptText: string, transcriptionId: string | null): string {
    // This is now just a wrapper to the conversational fallback for consistency
    return this.generateConversationalFallback(question, transcriptText);
  }

}

export default new APIService();