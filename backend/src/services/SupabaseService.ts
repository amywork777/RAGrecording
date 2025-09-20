import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface DocumentUpsertInput {
  ze_collection_name: string;
  ze_path: string;
  ze_document_id?: string | null;
  recording_id?: string | null;
  timestamp?: string | null; // ISO
  topic?: string | null;
  mime_type?: string | null;
  original_name?: string | null;
  size_bytes?: number | null;
  source?: string | null;
  ze_index_status?: string | null;
  device_name?: string | null;
  duration_seconds?: number | null;
}

class SupabaseService {
  private client: SupabaseClient | null = null;

  private getClient(): SupabaseClient | null {
    if (this.client) return this.client;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) return null;
    this.client = createClient(url, key);
    return this.client;
  }

  isConfigured(): boolean {
    return !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY));
  }

  async upsertDocument(input: DocumentUpsertInput): Promise<string | null> {
    const supabase = this.getClient();
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('documents')
      .upsert({
        ze_collection_name: input.ze_collection_name,
        ze_path: input.ze_path,
        ze_document_id: input.ze_document_id || null,
        recording_id: input.recording_id || null,
        timestamp: input.timestamp || null,
        topic: input.topic || null,
        mime_type: input.mime_type || null,
        original_name: input.original_name || null,
        size_bytes: input.size_bytes ?? null,
        source: input.source || null,
        ze_index_status: input.ze_index_status || null,
        device_name: input.device_name || null,
        duration_seconds: input.duration_seconds ?? null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'ze_collection_name,ze_path'
      })
      .select('id')
      .single();

    if (error) {
      console.error('Supabase upsertDocument error:', error);
      return null;
    }
    return data?.id ?? null;
  }

  async setLatestAnnotation(documentId: string, title: string, summary: string, model?: string, tokens_used?: number): Promise<void> {
    const supabase = this.getClient();
    if (!supabase) return;
    // Mark previous latest false
    const { error: updErr } = await supabase
      .from('ai_annotations')
      .update({ is_latest: false })
      .eq('document_id', documentId)
      .eq('is_latest', true);
    if (updErr) {
      console.warn('Supabase setLatestAnnotation: could not mark previous latest false', updErr);
    }
    // Insert new latest
    const { error: insErr } = await supabase
      .from('ai_annotations')
      .insert({
        document_id: documentId,
        title,
        summary,
        model: model || null,
        tokens_used: tokens_used || null,
        is_latest: true,
      });
    if (insErr) {
      console.error('Supabase setLatestAnnotation insert error:', insErr);
    }
  }

  async startSession(input: { user_id: string; source: 'phone'|'omi'; vendor: string; sample_rate: number }): Promise<string | null> {
    const supabase = this.getClient();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('sessions')
      .insert({
        user_id: input.user_id,
        source: input.source,
        vendor: input.vendor,
        sample_rate: input.sample_rate,
        started_at: new Date().toISOString(),
        status: 'active'
      })
      .select('id')
      .single();
    if (error) {
      console.error('Supabase startSession error:', error);
      return null;
    }
    return data?.id ?? null;
  }

  async endSession(session_id: string): Promise<void> {
    const supabase = this.getClient();
    if (!supabase) return;
    const { error } = await supabase
      .from('sessions')
      .update({ ended_at: new Date().toISOString(), status: 'ended' })
      .eq('id', session_id);
    if (error) {
      console.error('Supabase endSession error:', error);
    }
  }

  async addFinalSegment(input: { session_id: string; start_ms: number; end_ms: number; text: string; words_json?: any }): Promise<void> {
    const supabase = this.getClient();
    if (!supabase) return;
    const { error } = await supabase
      .from('segments')
      .insert({
        session_id: input.session_id,
        start_ms: input.start_ms,
        end_ms: input.end_ms,
        text: input.text,
        words_json: input.words_json || null,
        is_final: true,
        created_at: new Date().toISOString()
      });
    if (error) {
      console.error('Supabase addFinalSegment error:', error);
    }
  }

  async fetchLatestAnnotationByPath(ze_collection_name: string, ze_path: string): Promise<{ title: string; summary: string } | null> {
    const supabase = this.getClient();
    if (!supabase) return null;

    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('id')
      .eq('ze_collection_name', ze_collection_name)
      .eq('ze_path', ze_path)
      .single();
    if (docErr || !doc) return null;

    const { data: ann, error: annErr } = await supabase
      .from('ai_annotations')
      .select('title, summary')
      .eq('document_id', doc.id)
      .eq('is_latest', true)
      .limit(1)
      .single();
    if (annErr || !ann) return null;
    return { title: ann.title, summary: ann.summary };
  }

  async fetchDocumentByPath(ze_collection_name: string, ze_path: string): Promise<{ id: string; duration_seconds: number | null } | null> {
    const supabase = this.getClient();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('documents')
      .select('id, duration_seconds')
      .eq('ze_collection_name', ze_collection_name)
      .eq('ze_path', ze_path)
      .single();
    if (error || !data) return null;
    return data as any;
  }
}

export default new SupabaseService();

