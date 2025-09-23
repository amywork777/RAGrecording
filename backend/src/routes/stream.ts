import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  return secret;
};

router.post('/token', async (req: Request, res: Response) => {
  try {
    const { source, sample_rate } = req.body || {};
    const src = source === 'omi' ? 'omi' : 'phone';
    const sr = typeof sample_rate === 'number' ? sample_rate : (src === 'omi' ? 48000 : 16000);

    // TODO: Replace with real auth/user; for now allow anonymous/dev
    const userId = (req as any).user?.id || 'anon';

    const ttlSeconds = Math.max(60, Math.min(600, parseInt(process.env.STREAM_JWT_TTL_SECONDS || '600')));
    const now = Math.floor(Date.now() / 1000);
    const sessionId = `${now}-${Math.random().toString(36).slice(2, 10)}`;

    const token = jwt.sign(
      { user_id: userId, session_id: sessionId, src, sr, iat: now, exp: now + ttlSeconds },
      getJwtSecret()
    );

    const relayUrl = (process.env.RELAY_WS_URL || '').trim();

    // Derive WS URL from request host if not explicitly configured
    let wsUrl: string;
    if (relayUrl) {
      wsUrl = relayUrl;
    } else {
      const host = req.headers['x-forwarded-host'] as string || req.headers.host || '';
      // Prefer forwarded proto when behind proxies (Vercel/NGINX)
      const forwardedProto = (req.headers['x-forwarded-proto'] as string) || '';
      const isSecure = forwardedProto.includes('https');
      const scheme = isSecure ? 'wss' : 'ws';
      // Fallback: if no host header, default to localhost (dev)
      wsUrl = host ? `${scheme}://${host}/ws` : `ws://localhost:${process.env.PORT || 3000}/ws`;
    }

    res.json({ token, relay_ws_url: wsUrl });
  } catch (e) {
    console.error('stream/token error', e);
    res.status(500).json({ error: 'Failed to issue stream token' });
  }
});

export default router;


