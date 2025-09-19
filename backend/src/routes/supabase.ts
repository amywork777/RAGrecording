import { Router, Request, Response } from 'express';
import SupabaseService from '../services/SupabaseService';
import ZeroEntropy from 'zeroentropy';

const router = Router();

const getZeroEntropyClient = () => {
  const apiKey = (process.env.ZEROENTROPY_API_KEY || '').trim();
  if (!apiKey || !apiKey.startsWith('ze_')) {
    throw new Error('ZeroEntropy API key not configured');
  }
  const base_url = (process.env.ZEROENTROPY_BASE_URL || 'https://api.zeroentropy.dev/v1').trim();
  return new ZeroEntropy({ apiKey, base_url } as any);
};

// GET /api/supabase/recent?limit=100
router.get('/recent', async (req: Request, res: Response) => {
  try {
    if (!SupabaseService.isConfigured()) {
      return res.status(400).json({ error: 'Supabase not configured on server' });
    }

    const requested = parseInt(req.query.limit as string) || 100;
    const limit = Math.max(1, Math.min(requested, 200));

    // 1) Fetch recent documents from Supabase
    const supabase = (SupabaseService as any);
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL as string;
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY) as string;
    const client = createClient(url, key);

    const { data: docs, error } = await client
      .from('documents')
      .select('id, ze_collection_name, ze_path, timestamp, duration_seconds')
      .order('timestamp', { ascending: false })
      .limit(limit);
    if (error) throw error;

    const ze = getZeroEntropyClient();
    const out = [] as any[];
    for (const d of (docs || [])) {
      const path = d.ze_path as string;
      // Fetch latest annotation
      let title: string | null = null;
      let summary: string | null = null;
      try {
        const { data: docRow, error: docErr } = await client
          .from('documents')
          .select('id')
          .eq('ze_collection_name', d.ze_collection_name)
          .eq('ze_path', path)
          .single();
        if (!docErr && docRow) {
          const { data: ann, error: annErr } = await client
            .from('ai_annotations')
            .select('title, summary')
            .eq('document_id', docRow.id)
            .eq('is_latest', true)
            .limit(1)
            .single();
          if (!annErr && ann) { title = ann.title; summary = ann.summary; }
        }
      } catch {}

      // Fetch content from ZE by path
      let text = '';
      try {
        const info: any = await ze.documents.getInfo({
          collection_name: d.ze_collection_name || 'ai-wearable-transcripts',
          path,
          include_content: true,
        } as any);
        text = info?.document?.content || '';
      } catch {}

      out.push({
        id: d.id,
        path,
        text,
        title,
        summary,
        timestamp: d.timestamp,
        duration_seconds: d.duration_seconds ?? null,
        aiTitle: title,
        aiSummary: summary,
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ documents: out, count: out.length, source: 'supabase' });
  } catch (e: any) {
    console.error('Supabase recent error:', e);
    res.status(500).json({ error: 'Failed to fetch recent documents', message: e?.message });
  }
});

export default router;


