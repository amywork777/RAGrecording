import app from '../src/app';

export default function handler(req: any, res: any) {
  (app as any)(req, res);
}


