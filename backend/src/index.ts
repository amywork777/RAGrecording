import http from 'http';
import app from './app';
import { attachRealtimeRelay } from './realtime/relay';

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

attachRealtimeRelay(server);

server.listen(PORT, () => {
  console.log(`AI Wearable Companion Backend running on port ${PORT}`);
});