import { Router, Request, Response } from 'express';
import ZeroEntropy from 'zeroentropy';
import GPTService from '../services/GPTService';
import multer from 'multer';
import TranscriptionService from '../services/TranscriptionService';
import ClaudeService from '../services/ClaudeService';
import SupabaseService from '../services/SupabaseService';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Initialize ZeroEntropy client
const getZeroEntropyClient = () => {
  const apiKey = (process.env.ZEROENTROPY_API_KEY || '').trim();
  if (!apiKey || !apiKey.startsWith('ze_')) {
    throw new Error('ZeroEntropy API key not configured');
  }
  const baseUrl = (process.env.ZEROENTROPY_BASE_URL || 'https://api.zeroentropy.ai/v1').trim();
  return new ZeroEntropy({ apiKey, base_url: baseUrl } as any);
};

// Get all documents from ZeroEntropy
router.get('/documents', async (req: Request, res: Response) => {
  try {
    const requestedLimit = parseInt(req.query.limit as string) || 50;
    const limit = Math.max(1, Math.min(requestedLimit, 100)); // safety cap
    const client = getZeroEntropyClient();
    const collection_name = 'ai-wearable-transcripts';
    console.log('Fetching documents from ZeroEntropy...');

    // Paginate to the end to get the most recent N docs
    const batchSize = 200;
    let id_gt: string | undefined = undefined;
    const tail: any[] = [];
    for (let i = 0; i < 50; i++) { // safety bound
      const page: any = await client.documents.getInfoList({
        collection_name,
        limit: batchSize,
        id_gt,
      } as any);
      const docs = (page?.documents || []) as any[];
      if (!docs.length) break;
      tail.push(...docs);
      // Keep only the last "limit" items
      if (tail.length > limit) tail.splice(0, tail.length - limit);
      id_gt = docs[docs.length - 1]?.id;
      if (docs.length < batchSize) break; // reached end
    }

    // Fetch content for the final tail set
    const docsWithContent = await Promise.all(
      tail.map(async (doc: any) => {
        try {
          const docInfo = await client.documents.getInfo({
            collection_name,
            path: doc.path,
            include_content: true,
          } as any);
          return (docInfo as any).document;
        } catch (error) {
          console.error(`Error fetching content for ${doc.path}:`, error);
          return doc;
        }
      })
    );
    
    // Format the documents for the frontend
    const formattedDocs = await Promise.all(
      docsWithContent.map(async (doc: any) => {
        const base: any = {
          id: doc.id,
          text: doc.content || '',
          title: doc.metadata?.title || 'Untitled',
          summary: doc.metadata?.summary || '',
          timestamp: doc.metadata?.timestamp || new Date().toISOString(),
          recordingId: doc.metadata?.recordingId || 'unknown',
          topic: doc.metadata?.topic || '',
          score: 1.0,
          path: doc.path,
          indexStatus: doc.index_status,
        };
        try {
          if (SupabaseService.isConfigured()) {
            const ann = await SupabaseService.fetchLatestAnnotationByPath('ai-wearable-transcripts', doc.path);
            if (ann) {
              base.aiTitle = ann.title;
              base.aiSummary = ann.summary;
            }
            const supDoc = await SupabaseService.fetchDocumentByPath('ai-wearable-transcripts', doc.path);
            if (supDoc) {
              base.durationSeconds = supDoc.duration_seconds ?? null;
            }
          }
        } catch {}
        return base;
      })
    );
    
    // Sort by timestamp desc, then by path desc for stability
    formattedDocs.sort((a: any, b: any) => {
      const tb = new Date(b.timestamp).getTime();
      const ta = new Date(a.timestamp).getTime();
      if (tb !== ta) return tb - ta;
      return (b.path || '').localeCompare(a.path || '');
    });
    
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      documents: formattedDocs,
      count: formattedDocs.length,
      source: 'zeroentropy',
    });
  } catch (error: any) {
    console.error('Error fetching documents from ZeroEntropy:', error);
    res.status(500).json({ 
      error: 'Failed to fetch documents',
      message: error.message 
    });
  }
});

// Get a single document by path (include content)
router.get('/document-by-path', async (req: Request, res: Response) => {
  try {
    const path = req.query.path as string;
    const collection_name = (req.query.collection_name as string) || 'ai-wearable-transcripts';
    if (!path) {
      return res.status(400).json({ error: 'Missing required query param: path' });
    }

    const client = getZeroEntropyClient();
    const docInfo = await client.documents.getInfo({
      collection_name,
      path,
      include_content: true,
    } as any);

    const doc: any = (docInfo as any).document;
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Format similar to list endpoint shape
    const base: any = {
      id: doc.id,
      text: doc.content || '',
      title: doc.metadata?.title || 'Untitled',
      summary: doc.metadata?.summary || '',
      timestamp: doc.metadata?.timestamp || new Date().toISOString(),
      recordingId: doc.metadata?.recordingId || 'unknown',
      topic: doc.metadata?.topic || '',
      score: 1.0,
      path: doc.path,
      indexStatus: doc.index_status,
    };

    try {
      if (SupabaseService.isConfigured()) {
        const ann = await SupabaseService.fetchLatestAnnotationByPath(collection_name, doc.path);
        if (ann) {
          base.aiTitle = ann.title;
          base.aiSummary = ann.summary;
        }
        const supDoc = await SupabaseService.fetchDocumentByPath(collection_name, doc.path);
        if (supDoc) {
          base.durationSeconds = supDoc.duration_seconds ?? null;
        }
      }
    } catch {}

    res.json(base);
  } catch (error: any) {
    console.error('Error fetching document by path:', error);
    res.status(500).json({ error: 'Failed to fetch document by path', message: error.message });
  }
});


// Search documents in ZeroEntropy with GPT-powered answers (semantic search)
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { query, limit = 10, useGPT = true } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    const client = getZeroEntropyClient();
    
    console.log(`Searching ZeroEntropy for: "${query}"`);
    
    // Search in ZeroEntropy
    const searchResults = await client.queries.topDocuments({
      collection_name: 'ai-wearable-transcripts',
      query: query,
      k: limit,
      include_metadata: true,
    });
    
    // Get document content for top results
    const topDocs = await Promise.all(
      ((searchResults as any).results || []).slice(0, 5).map(async (result: any) => {
        try {
          const docInfo = await client.documents.getInfo({
            collection_name: 'ai-wearable-transcripts',
            path: result.path,
            include_content: true,
          });
          return {
            path: result.path,
            score: result.score,
            content: (docInfo as any).document?.content || '',
            metadata: result.metadata || {},
          };
        } catch (error) {
          console.error(`Error fetching content for ${result.path}:`, error);
          return {
            path: result.path,
            score: result.score,
            content: '',
            metadata: result.metadata || {},
          };
        }
      })
    );
    
    // Generate GPT answer if requested
    let answer: string | undefined;
    let sources: any[] = [];
    if (useGPT && topDocs.length > 0) {
      const contextDocs = topDocs.map(doc => ({
        text: doc.content,
        topic: doc.metadata?.topic || 'Unknown',
        timestamp: doc.metadata?.timestamp || '',
        score: doc.score,
        path: doc.path,
      }));
      
      const gptResponse = await GPTService.generateConversationalResponse(query, contextDocs);
      answer = gptResponse.answer;
      sources = gptResponse.sources;
    }
    
    // Format the results
    const formattedResults = topDocs.map((doc: any) => ({
      text: doc.content,
      title: doc.metadata?.title || 'Untitled',
      summary: doc.metadata?.summary || '',
      score: doc.score,
      metadata: doc.metadata,
      path: doc.path,
    }));
    
    res.json({
      results: formattedResults,
      answer: answer,
      sources: sources,
      query: query,
      source: 'zeroentropy+gpt',
      model: useGPT ? 'gpt-3.5-turbo' : null,
    });
  } catch (error: any) {
    console.error('Error searching in ZeroEntropy:', error);
    res.status(500).json({ 
      error: 'Failed to search documents',
      message: error.message 
    });
  }
});

// Get ZeroEntropy status
router.get('/status', async (req: Request, res: Response) => {
  try {
    const client = getZeroEntropyClient();
    
    // Get collections
    const collections = await client.collections.getList({});
    
    // Get document count for our collection
    const documents = await client.documents.getInfoList({
      collection_name: 'ai-wearable-transcripts',
      limit: 100,
    });
    
    res.json({
      status: 'connected',
      collections: (collections as any).collection_names || [],
      documentCount: (documents as any).documents?.length || 0,
      apiKeyConfigured: true,
    });
  } catch (error: any) {
    res.json({
      status: 'error',
      error: error.message,
      apiKeyConfigured: !!process.env.ZEROENTROPY_API_KEY,
    });
  }
});

// Upload a plain text document to ZeroEntropy
router.post('/upload-text', async (req: Request, res: Response) => {
  try {
    const { text, path = 'uploads/mobile-text.txt', metadata = {}, collection_name = 'ai-wearable-transcripts' } = req.body || {};

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing required field: text' });
    }

    const client = getZeroEntropyClient();
    
    console.log(`Uploading text document to ZeroEntropy:`);
    console.log(`- Path: ${path}`);
    console.log(`- Collection: ${collection_name}`);
    console.log(`- Text length: ${text.length} characters`);
    console.log(`- First 100 chars: ${text.substring(0, 100)}...`);

    const response = await client.documents.add({
      collection_name,
      path,
      content: {
        type: 'text',
        text,
      },
      metadata: {
        timestamp: new Date().toISOString(),
        ...metadata,
      } as any,
    } as any);
    
    console.log('Document successfully uploaded to ZeroEntropy:', response);

    res.json({
      message: 'Document uploaded to ZeroEntropy',
      response,
      path,
      collection_name,
      textLength: text.length,
    });

    // Fire-and-forget: upsert Supabase + AI annotation
    ;(async () => {
      try {
        if (!SupabaseService.isConfigured()) return;
        const docId = await SupabaseService.upsertDocument({
          ze_collection_name: collection_name,
          ze_path: path,
          ze_document_id: (response as any)?.document?.id || null,
          recording_id: (req.body?.metadata?.recordingId as string) || null,
          timestamp: new Date().toISOString(),
          topic: (req.body?.metadata?.topic as string) || null,
          mime_type: 'text/plain',
          original_name: null,
          size_bytes: (text?.length as number) || null,
          source: 'mobile-text',
          ze_index_status: (response as any)?.document?.index_status || null,
          device_name: null,
        });
        if (docId) {
          const { title, summary } = await ClaudeService.generateTitleAndSummary(text);
          await SupabaseService.setLatestAnnotation(docId, title, summary, 'claude');
        }
      } catch (e) {
        console.warn('Supabase upsert (upload-text) failed:', e);
      }
    })();
  } catch (error: any) {
    console.error('Error uploading text to ZeroEntropy:', error);
    res.status(500).json({ error: 'Failed to upload document', message: error.message });
  }
});

// Delete a document from ZeroEntropy by collection_name + path
router.post('/delete-document', async (req: Request, res: Response) => {
  try {
    const { collection_name = 'ai-wearable-transcripts', path } = req.body || {};

    if (!path || typeof path !== 'string') {
      return res.status(400).json({ error: 'Missing required field: path' });
    }

    const client = getZeroEntropyClient();

    const response = await client.documents.delete({
      collection_name,
      path,
    } as any);

    res.json({ message: 'Document deleted', response, path, collection_name });
  } catch (error: any) {
    console.error('Error deleting document from ZeroEntropy:', error);
    res.status(500).json({ error: 'Failed to delete document', message: error.message });
  }
});

// Sync ZeroEntropy documents into Supabase (metadata + optional AI annotations)
// POST /api/zeroentropy/sync-to-supabase
// body: { limit?: number, includeAnnotations?: boolean }
router.post('/sync-to-supabase', async (req: Request, res: Response) => {
  try {
    if (!SupabaseService.isConfigured()) {
      return res.status(400).json({ error: 'Supabase not configured on server' });
    }

    const limit = parseInt(req.body?.limit) || 200;
    const includeAnnotations = req.body?.includeAnnotations !== false; // default true
    const client = getZeroEntropyClient();
    const collection_name = 'ai-wearable-transcripts';

    // Fetch list of docs, then fetch content for each
    const list = await client.documents.getInfoList({
      collection_name,
      limit,
    });

    const docsWithContent = await Promise.all(
      ((list as any).documents || []).map(async (doc: any) => {
        try {
          const docInfo = await client.documents.getInfo({
            collection_name,
            path: doc.path,
            include_content: true,
          });
          return (docInfo as any).document;
        } catch (e) {
          return doc; // fallback without content
        }
      })
    );

    let upserted = 0;
    let annotated = 0;
    for (const d of docsWithContent) {
      const meta = d?.metadata || {};
      const docId = await SupabaseService.upsertDocument({
        ze_collection_name: collection_name,
        ze_path: d.path,
        ze_document_id: d.id || null,
        recording_id: meta?.recordingId || null,
        timestamp: meta?.timestamp || null,
        topic: meta?.topic || null,
        mime_type: 'text/plain',
        original_name: meta?.original_name || null,
        size_bytes: null,
        source: meta?.source || 'zeroentropy-import',
        ze_index_status: d.index_status || null,
        device_name: meta?.device_name || null,
      });
      if (docId) {
        upserted += 1;
        if (includeAnnotations) {
          const text: string = d?.content || '';
          const { title, summary } = await ClaudeService.generateTitleAndSummary(text);
          await SupabaseService.setLatestAnnotation(docId, title, summary, 'claude');
          annotated += 1;
        }
      }
    }

    res.json({
      message: 'Sync completed',
      collection: collection_name,
      requested: ((list as any).documents || []).length,
      upserted,
      annotated,
    });
  } catch (error: any) {
    console.error('Error syncing to Supabase:', error);
    res.status(500).json({ error: 'Failed to sync to Supabase', message: error.message });
  }
});

// Upload a file (.txt direct; .wav/.m4a/.mp4 transcribe then upload)
router.post('/upload-file', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const client = getZeroEntropyClient();
    const { originalname = '', mimetype } = req.file;
    const lower = originalname.toLowerCase();
    const isText = lower.endsWith('.txt') || mimetype === 'text/plain';
    const isAudio = lower.endsWith('.wav') || lower.endsWith('.m4a') || lower.endsWith('.mp4') || mimetype.startsWith('audio/');

    const collection_name = 'ai-wearable-transcripts';
    const path = `mobile/uploads/${Date.now()}_${originalname || 'upload'}`;

    let text: string;
    let durationSeconds: number | null = null;
    if (isText) {
      text = req.file.buffer.toString('utf-8');
    } else if (isAudio) {
      const format = lower.endsWith('.wav') ? 'wav' : 'm4a';
      const startMs = Date.now();
      const result = await TranscriptionService.transcribeAudio(req.file.buffer, format);
      durationSeconds = Math.max(1, Math.round((Date.now() - startMs) / 1000));
      text = result.transcription;
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Use .txt, .wav, .m4a, or .mp4' });
    }

    const response = await client.documents.add({
      collection_name,
      path,
      content: { type: 'text', text },
      metadata: {
        timestamp: new Date().toISOString(),
        original_name: originalname,
        mime_type: mimetype,
        size: `${req.file.size}`,
        source: isText ? 'mobile-text' : 'mobile-audio',
      } as any,
    } as any);

    res.json({ message: 'Uploaded', path, collection_name, response });

    // Fire-and-forget: upsert Supabase + AI annotation
    ;(async () => {
      try {
        if (!SupabaseService.isConfigured()) return;
        const docId = await SupabaseService.upsertDocument({
          ze_collection_name: collection_name,
          ze_path: path,
          ze_document_id: (response as any)?.document?.id || null,
          recording_id: null,
          timestamp: new Date().toISOString(),
          topic: null,
          mime_type: 'text/plain',
          original_name: originalname,
          size_bytes: (req.file?.size as number) || null,
          source: isText ? 'mobile-text' : 'mobile-audio',
          ze_index_status: (response as any)?.document?.index_status || null,
          device_name: null,
          duration_seconds: durationSeconds,
        });
        if (docId) {
          const { title, summary } = await ClaudeService.generateTitleAndSummary(text);
          await SupabaseService.setLatestAnnotation(docId, title, summary, 'claude');
        }
      } catch (e) {
        console.warn('Supabase upsert (upload-file) failed:', e);
      }
    })();
  } catch (error: any) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file', message: error.message });
  }
});

export default router;