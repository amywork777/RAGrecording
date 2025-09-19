import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import transcriptionRoutes from './routes/transcription';
import searchRoutes from './routes/search';
import zeroEntropyRoutes from './routes/zeroentropy';
import supabaseRoutes from './routes/supabase';
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check at both /health and /api/health for Vercel function path
const healthHandler = (_req: express.Request, res: express.Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      transcription: 'operational',
      zeroentropy: 'operational',
      search: 'operational',
    },
  });
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

app.use('/api', transcriptionRoutes);
app.use('/api', searchRoutes);
app.use('/api/zeroentropy', zeroEntropyRoutes);
app.use('/api/supabase', supabaseRoutes);

app.use(errorHandler);

export default app;


