import { v4 as uuidv4 } from 'uuid';
import MockDataService from './MockDataService';

interface Document {
  id: string;
  text: string;
  metadata: {
    timestamp: string;
    recordingId: string;
    userId?: string;
  };
}

interface SearchResult {
  id: string;
  text: string;
  score: number;
  metadata: any;
}

class ZeroEntropyService {
  private apiKey: string;
  private projectId: string;
  private baseUrl = 'https://api.zeroentropy.ai/v1';
  private useMockData = true; // Toggle for testing

  constructor() {
    this.apiKey = (process.env.ZEROENTROPY_API_KEY || '').trim();
    this.projectId = (process.env.ZEROENTROPY_PROJECT_ID || '').trim();
  }

  async storeDocument(text: string, metadata: any): Promise<string> {
    const documentId = uuidv4();
    
    try {
      // Try to use real ZeroEntropy API
      const ZeroEntropy = (await import('zeroentropy')).default;
      const client = new ZeroEntropy({ apiKey: this.apiKey });
      
      await client.documents.add({
        collection_name: 'ai-wearable-transcripts',
        path: `recordings/recording-${documentId}.txt`,
        content: {
          type: 'text',
          text: text,
        },
        metadata: {
          ...metadata,
          timestamp: new Date().toISOString(),
          source: 'user-recording',
        },
      });
      
      console.log(`Document stored in ZeroEntropy: ${documentId}`);
      return documentId;
    } catch (error) {
      console.error('Error storing document in ZeroEntropy:', error);
      console.log('Using mock data storage instead...');
      return await MockDataService.addTranscript(text, metadata.recordingId);
    }
  }

  async search(query: string, limit: number = 5): Promise<SearchResult[]> {
    if (this.useMockData) {
      const results = await MockDataService.searchTranscripts(query, limit);
      return results.map(r => ({
        id: r.id,
        text: r.text,
        score: Math.random() * 0.3 + 0.7, // Random score between 0.7-1.0
        metadata: {
          timestamp: r.timestamp,
          recordingId: r.recordingId
        }
      }));
    }

    try {
      const response = await fetch(`${this.baseUrl}/projects/${this.projectId}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          limit,
          include_metadata: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`ZeroEntropy API error: ${response.statusText}`);
      }

      const data: any = await response.json();
      return data.results;
    } catch (error) {
      console.error('Error searching in ZeroEntropy:', error);
      console.log('Using mock data for search...');
      
      const results = await MockDataService.searchTranscripts(query, limit);
      return results.map(r => ({
        id: r.id,
        text: r.text,
        score: Math.random() * 0.3 + 0.7,
        metadata: {
          timestamp: r.timestamp,
          recordingId: r.recordingId
        }
      }));
    }
  }

  async generateAnswer(query: string, context: SearchResult[]): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/projects/${this.projectId}/generate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          context: context.map(r => r.text).join('\n\n'),
          max_tokens: 200,
        }),
      });

      if (!response.ok) {
        throw new Error(`ZeroEntropy API error: ${response.statusText}`);
      }

      const data: any = await response.json();
      return data.answer;
    } catch (error) {
      console.error('Error generating answer with ZeroEntropy:', error);
      return `Based on your recordings: ${context[0]?.text || 'No relevant information found.'}`;
    }
  }

  private getSimulatedResults(query: string, limit: number): SearchResult[] {
    const simulatedResults: SearchResult[] = [
      {
        id: uuidv4(),
        text: 'Discussed the project timeline and key milestones for Q4.',
        score: 0.92,
        metadata: {
          timestamp: new Date(Date.now() - 86400000).toISOString(),
          recordingId: uuidv4(),
        },
      },
      {
        id: uuidv4(),
        text: 'Meeting about the new feature implementation and technical requirements.',
        score: 0.85,
        metadata: {
          timestamp: new Date(Date.now() - 172800000).toISOString(),
          recordingId: uuidv4(),
        },
      },
      {
        id: uuidv4(),
        text: 'Review of the user feedback and proposed improvements to the UI.',
        score: 0.78,
        metadata: {
          timestamp: new Date(Date.now() - 259200000).toISOString(),
          recordingId: uuidv4(),
        },
      },
    ];

    return simulatedResults.slice(0, limit);
  }

  async deleteDocument(documentId: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/projects/${this.projectId}/documents/${documentId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`ZeroEntropy API error: ${response.statusText}`);
      }

      console.log(`Document deleted from ZeroEntropy: ${documentId}`);
    } catch (error) {
      console.error('Error deleting document from ZeroEntropy:', error);
    }
  }
}

export default new ZeroEntropyService();