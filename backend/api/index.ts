import app from '../src/app';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  // Let Express handle the request
  (app as any)(req, res);
}


