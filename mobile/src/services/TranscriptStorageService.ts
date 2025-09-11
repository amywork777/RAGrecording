import AsyncStorage from '@react-native-async-storage/async-storage';

const TRANSCRIPT_STORAGE_KEY = 'transcripts_v2';
const MAX_STORED_TRANSCRIPTS = 100;

interface Transcript {
  id: string;
  text: string;
  title?: string;
  summary?: string;
  timestamp: Date;
  isExpanded?: boolean;
  path?: string;
  aiTitle?: string;
  aiSummary?: string;
  durationSeconds?: number | null;
  duration_seconds?: number | null;
  localAudioPath?: string;
  remoteAudioUrl?: string;
  source?: 'ble' | 'recording' | 'upload' | 'hardware' | 'backend';
}

class TranscriptStorageService {
  async saveTranscripts(transcripts: Transcript[]): Promise<void> {
    try {
      // Keep only the most recent transcripts to avoid storage bloat
      const transcriptsToStore = transcripts
        .slice(0, MAX_STORED_TRANSCRIPTS)
        .map(t => ({
          ...t,
          timestamp: t.timestamp.toISOString(), // Convert Date to string for JSON storage
        }));

      await AsyncStorage.setItem(
        TRANSCRIPT_STORAGE_KEY,
        JSON.stringify({
          transcripts: transcriptsToStore,
          lastUpdated: new Date().toISOString(),
        })
      );

      console.log(`💾 Saved ${transcriptsToStore.length} transcripts to local storage`);
    } catch (error) {
      console.error('Failed to save transcripts to local storage:', error);
    }
  }

  async loadTranscripts(): Promise<Transcript[]> {
    try {
      const storedData = await AsyncStorage.getItem(TRANSCRIPT_STORAGE_KEY);
      if (!storedData) {
        console.log('📱 No stored transcripts found');
        return [];
      }

      const parsed = JSON.parse(storedData);
      const transcripts = parsed.transcripts?.map((t: any) => ({
        ...t,
        timestamp: new Date(t.timestamp), // Convert string back to Date
      })) || [];

      console.log(`📱 Loaded ${transcripts.length} transcripts from local storage`);
      return transcripts;
    } catch (error) {
      console.error('Failed to load transcripts from local storage:', error);
      return [];
    }
  }

  async clearTranscripts(): Promise<void> {
    try {
      await AsyncStorage.removeItem(TRANSCRIPT_STORAGE_KEY);
      console.log('🗑️ Cleared local transcript storage');
    } catch (error) {
      console.error('Failed to clear transcript storage:', error);
    }
  }

  async addTranscript(transcript: Transcript): Promise<void> {
    try {
      const existingTranscripts = await this.loadTranscripts();
      
      // Remove any existing transcript with the same ID to prevent duplicates
      const filteredTranscripts = existingTranscripts.filter(t => t.id !== transcript.id);
      
      // Add new transcript at the beginning
      const updatedTranscripts = [transcript, ...filteredTranscripts];
      
      await this.saveTranscripts(updatedTranscripts);
      console.log(`➕ Added transcript ${transcript.id} to local storage`);
    } catch (error) {
      console.error('Failed to add transcript to local storage:', error);
    }
  }

  async removeTranscript(transcriptId: string): Promise<void> {
    try {
      const existingTranscripts = await this.loadTranscripts();
      const filteredTranscripts = existingTranscripts.filter(t => t.id !== transcriptId);
      
      await this.saveTranscripts(filteredTranscripts);
      console.log(`➖ Removed transcript ${transcriptId} from local storage`);
    } catch (error) {
      console.error('Failed to remove transcript from local storage:', error);
    }
  }
}

export default new TranscriptStorageService();