import OpenAI from 'openai';

class GPTService {
  private openai: OpenAI | null = null;

  constructor() {}

  private getOpenAI(): OpenAI {
    if (this.openai) return this.openai;
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY missing');
    this.openai = new OpenAI({ apiKey: key });
    return this.openai;
  }

  async generateAnswer(query: string, context: any[]): Promise<string> {
    try {
      // Prepare context from ZeroEntropy search results
      const contextText = context.map((doc, index) => 
        `[Document ${index + 1}]:\n${doc.text || doc.content || ''}\n`
      ).join('\n');

      if (!contextText.trim()) {
        return "I couldn't find any relevant information in your recordings to answer that question.";
      }

      // Create the prompt for GPT
      const systemPrompt = `You are an AI assistant helping users find information from their personal recordings and notes. 
You have access to transcripts from their wearable device that captures conversations and thoughts.
Answer questions based ONLY on the provided context. If the context doesn't contain relevant information, say so.
Be concise but helpful. Reference specific details from the context when relevant.`;

      const userPrompt = `Based on the following recordings/transcripts, please answer this question: "${query}"

Context from recordings:
${contextText}

Please provide a helpful answer based on the above context.`;

      console.log(`Generating GPT answer for query: "${query}" with ${context.length} context documents`);

      const openai = this.getOpenAI();
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 500,
      });

      const answer = completion.choices[0]?.message?.content || 'Unable to generate an answer.';
      
      return answer;
    } catch (error: any) {
      console.error('Error generating GPT answer:', error.message);
      
      // Fallback to simple answer if GPT fails
      if (context.length > 0 && context[0].text) {
        return `Based on your recordings: ${context[0].text.substring(0, 200)}...`;
      }
      
      return 'Unable to generate an answer at this time. Please try again.';
    }
  }

  async generateConversationalResponse(
    query: string, 
    context: any[], 
    conversationHistory?: { role: string; content: string }[]
  ): Promise<{ answer: string; sources: any[] }> {
    try {
      // Check if API key is configured
      if (!process.env.OPENAI_API_KEY) {
        console.error('OpenAI API key not configured');
        return { 
          answer: 'OpenAI API key is not configured. Please set OPENAI_API_KEY in your .env file.',
          sources: []
        };
      }

      const contextText = context.map((doc, index) => 
        `[${doc.topic || 'Recording'} - ${doc.timestamp || 'Unknown time'}]:\n${doc.text || doc.content || ''}\n`
      ).join('\n');

      const systemPrompt = `You are a concise AI assistant with access to the user's recordings.
Rules:
- Be extremely brief and direct
- Only answer what was asked
- No fluff or pleasantries
- Reference recordings only when necessary
- If no relevant info exists, just say so`;

      const messages: any[] = [
        { role: 'system', content: systemPrompt }
      ];

      // Add conversation history if provided
      if (conversationHistory && conversationHistory.length > 0) {
        messages.push(...conversationHistory.slice(-4)); // Keep last 4 messages for context
      }

      // Add current query with context
      messages.push({
        role: 'user',
        content: `Question: ${query}\n\nRelevant recordings:\n${contextText || 'No relevant recordings found.'}`
      });

      console.log(`Calling OpenAI API with model: gpt-3.5-turbo`);
      console.log(`Context documents: ${context.length}`);
      console.log(`Query: "${query}"`);

      const openai = this.getOpenAI();
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages,
        temperature: 0.3, // Lower temperature for more consistent, less creative responses
        max_tokens: 200, // Shorter responses
      });

      const answer = completion.choices[0]?.message?.content || 'I apologize, but I was unable to generate a response.';
      
      // Return answer with only the most relevant source
      const topSource = context.length > 0 ? context[0] : null;
      const sources = topSource ? [{
        id: topSource.id || topSource.recordingId || undefined,
        // Extract a brief 5-6 word quote from the source
        text: (topSource.text || topSource.content || '')
          .split(' ')
          .slice(0, 6)
          .join(' ') + '...',
        timestamp: topSource.timestamp,
        topic: topSource.topic || 'Recording',
        score: topSource.score,
      }] : [];
      
      return {
        answer,
        sources
      };
    } catch (error: any) {
      console.error('Error in conversational response:', error);
      console.error('Error details:', {
        message: error.message,
        status: error.status,
        response: error.response?.data
      });
      
      // More specific error messages
      const errorMessage = error.status === 401 
        ? 'Authentication error with OpenAI API. Please check your API key.'
        : error.status === 429
        ? 'Rate limit exceeded. Please try again in a moment.'
        : error.status === 500
        ? 'OpenAI service error. Please try again later.'
        : `Error generating response: ${error.message}`;
      
      return { answer: errorMessage, sources: [] };
    }
  }

  async summarizeTranscripts(transcripts: any[]): Promise<string> {
    try {
      if (transcripts.length === 0) {
        return 'No transcripts to summarize.';
      }

      const transcriptText = transcripts.map((t, i) => 
        `${i + 1}. ${t.text || t.content || ''}`
      ).join('\n\n');

      const prompt = `Please provide a concise summary of the following transcripts from a user's recordings:

${transcriptText}

Provide a brief summary highlighting the main topics and key information.`;

      const openai = this.getOpenAI();
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { 
            role: 'system', 
            content: 'You are a helpful assistant that creates concise summaries of personal recordings and notes.' 
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.5,
        max_tokens: 300,
      });

      return completion.choices[0]?.message?.content || 'Unable to generate summary.';
    } catch (error: any) {
      console.error('Error generating summary:', error.message);
      return 'Unable to generate summary at this time.';
    }
  }
}

export default new GPTService();