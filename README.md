# AI Wearable Companion App

A full-stack application for AI-powered wearable devices that records, transcribes, and enables intelligent search through conversations using RAG (Retrieval-Augmented Generation) technology.

## What's New (highlights)
- Persisted AI title and summary in Supabase to avoid regeneration on load
- Duration captured for audio uploads and recordings, displayed as N/A when unknown
- Copy-to-clipboard report in Mobile Record screen
- Backend-only diarization strategy: non‑diarized first pass → LLM single vs multi → diarize only if multi, with smoothing
- Sync endpoint to backfill ZeroEntropy docs into Supabase
- Auto-detect API base URL for Expo LAN

> more testing needed to be done for multi-speaker conversation

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Mobile App (Expo/React Native)          │
│  ┌─────────────┐                         ┌────────────┐    │
│  │ Record Screen│                         │ Chat Screen│    │
│  └──────┬──────┘                         └─────┬──────┘    │
│         │                                      │            │
│    ┌────▼────────────────────────────────────▼─────┐       │
│    │            BLE Service (Simulated)            │       │
│    └────────────────────┬───────────────────────────┘       │
└─────────────────────────┼───────────────────────────────────┘
                          │ Audio Chunks
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend (Node.js/Express)                 │
│  ┌──────────────────────────────────────────────────┐      │
│  │            Transcription Service (Whisper)       │      │
│  └──────────────────────┬───────────────────────────┘      │
│                         │                                   │
│  ┌──────────────────────▼───────────────────────────┐      │
│  │         ZeroEntropy RAG Pipeline                 │      │
│  │  • Embedding Generation                          │      │
│  │  • Vector Storage                                │      │
│  │  • Semantic Search                               │      │
│  │  • Answer Generation                             │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## Features

### Mobile App
- **BLE Connection**: Simulated Bluetooth Low Energy connection to wearable device
- **Audio Streaming**: Real-time audio chunk streaming from device
- **Live Transcription**: Display transcriptions as they're processed
- **Memory Search**: Natural language search through past conversations
- **Chat Interface**: Q&A interface for querying stored memories

### Backend
- **Audio Transcription**: OpenAI Whisper (batch) + AssemblyAI (batch + realtime)
- **Vector Storage**: ZeroEntropy integration for embeddings and storage
- **RAG Pipeline**: Full retrieval-augmented generation for intelligent answers
- **RESTful API**: Clean endpoints for transcription and search

## Tech Stack

### Frontend
- React Native with Expo
- TypeScript
- React Navigation
- BLE PLX (for future real BLE implementation)

### Backend
- Node.js with Express
- TypeScript
- OpenAI API (Whisper)
- ZeroEntropy SDK
- Multer for file handling

## Setup Instructions

### Prerequisites
- Node.js 18+ and npm
- Expo CLI (`npm install -g expo-cli`)
- OpenAI API key
- ZeroEntropy API key

### Backend Setup

1. Navigate to backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables in `.env`:
```env
PORT=3000
OPENAI_API_KEY=your_openai_api_key_here
ZEROENTROPY_API_KEY=your_zeroentropy_api_key_here
# Optional: AssemblyAI (for diarization & realtime)
ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
# Realtime relay
JWT_SECRET=replace_me
STREAM_JWT_TTL_SECONDS=600
# For mobile to learn where to connect
RELAY_WS_URL=wss://your-domain/ws
# ffmpeg binary path (if not in PATH)
FFMPEG_PATH=ffmpeg
# Optional: enable Supabase metadata + AI annotations
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
# or for dev only:
# SUPABASE_ANON_KEY=your_anon_key
```
### Realtime Streaming (dev quickstart)

1. Start backend: `npm run dev`
2. Get a token: `POST http://localhost:3000/api/stream/token {"source":"phone"}`
3. Connect WS: `ws://localhost:3000/ws?token=<token>`
4. Send config (text JSON), then binary frames (PCM16 16k mono or Opus Ogg 48k).
5. Receive `partial` and `final` events. Finals are persisted; a full transcript is uploaded to ZeroEntropy on session end.


4. Start the development server (run this inside the `backend` directory):
```bash
npm run dev
```

5. Verify the backend is reachable:
```bash
# From your Mac
open http://localhost:3000/health

# From your phone (must be on the same Wi‑Fi/LAN)
open http://<YOUR_MAC_LAN_IP>:3000/health
# Example: http://172.16.3.229:3000/health
```
You should see a small JSON payload with `status: "healthy"`.

### Mobile App Setup

1. Navigate to mobile directory:
```bash
cd mobile
```

2. Install dependencies:
```bash
npm install
```

3. Quick start (works on simulators and often on dev machines):
```bash
npx expo start
```
- If you run on an iOS/Android simulator, `localhost` will generally work out of the box.
- After the dev server starts, press `i` in the terminal to launch the iOS Simulator.
- If you run on a physical device and it loads fine, you can stop here.

4. If the app shows “Network request failed” on a physical device, configure the API endpoint:
- Find your Mac's LAN IP (Wi‑Fi):
```bash
# macOS Wi‑Fi
ipconfig getifaddr en0
# (If en0 prints nothing, try en1)
```
- Create `mobile/.env` with your LAN IP so the app can reach your backend:
```env
EXPO_PUBLIC_API_URL=http://<YOUR_MAC_LAN_IP>:3000
# Example: EXPO_PUBLIC_API_URL=http://172.16.3.229:3000
```
Notes:
- Expo automatically exposes variables that start with `EXPO_PUBLIC_` to the app.
- "localhost" only works in a simulator. On a real device, `localhost` points to the phone itself.

5. Start Expo development server (LAN mode recommended):
```bash
# Uses the .env value above
npx expo start --lan

# Or inject the URL one‑off and clear cache (useful if the app cached a bad URL)
EXPO_PUBLIC_API_URL=http://<YOUR_MAC_LAN_IP>:3000 npx expo start --lan --clear
```

6. Run on your device:
- Press `i` for iOS simulator
- Press `a` for Android emulator
- Scan QR code with Expo Go app for physical device

7. Confirm connectivity from your phone:
- Open `http://<YOUR_MAC_LAN_IP>:3000/health` in the phone’s browser. If that loads, the app should be able to reach the backend.

### Why this sometimes works on one machine but not another
- Simulators can use `http://localhost:3000`, so things “just work” on one dev’s machine.
- Physical devices cannot use your computer’s `localhost`. You must use your computer’s LAN IP and ensure both the phone and computer are on the same network, and the backend is listening on that IP/port.

### ZeroEntropy Setup (optional but recommended)
1. In `backend/.env`, set:
```env
ZEROENTROPY_API_KEY=ze_XXXXXXXXXXXXXXXXXXXXXXXX
OPENAI_API_KEY=sk-...                    # optional for GPT features
```
2. Restart the backend: `npm run dev`
3. Verify status from your phone or Mac:
```
http://<YOUR_MAC_LAN_IP>:3000/api/zeroentropy/status
```
You should see `status: connected` and `apiKeyConfigured: true` when configured correctly.

### Install the ZeroEntropy SDK
Using the official SDKs for Python and TypeScript / JavaScript.

#### TypeScript / JavaScript
```bash
npm install zeroentropy
```

#### Python (if applicable)
```bash
pip install zeroentropy
```

### Uploading Text Files from the Mobile App
- On the Record screen, use the Upload buttons to send either:
  - Text file → `POST /api/zeroentropy/upload-text`
  - Audio file (wav/m4a/mp4) → `POST /api/zeroentropy/upload-file` (transcribed via Whisper)
- The backend stores content in ZeroEntropy and, if Supabase is configured, upserts document metadata and saves AI title/summary.

Requirements:
- Backend must be running and reachable from the device (see LAN setup above).
- `ZEROENTROPY_API_KEY` must be set in `backend/.env`.
- To persist AI title/summary and avoid regeneration on load, set `SUPABASE_URL` and a key (`SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY`).
- Mobile dependencies installed: `expo-document-picker`, `expo-file-system`.

Troubleshooting:
- If the upload fails with 500, check `http://<YOUR_MAC_LAN_IP>:3000/api/zeroentropy/status` for `apiKeyConfigured: true`.
- Ensure the selected file is plain text (`text/plain`).

## API Endpoints
### GET /api/zeroentropy/documents
Returns recent documents from ZeroEntropy. When Supabase is configured, each document includes `aiTitle` and `aiSummary` (persisted), and `durationSeconds` when available.

### POST /api/zeroentropy/upload-text
Upload raw text and store as a document in ZeroEntropy. If Supabase is configured, also upserts `documents` and writes the latest AI `title/summary`.

### POST /api/zeroentropy/upload-file
Upload a file (.txt stored directly; .wav/.m4a/.mp4 transcribed first) and then stored in ZeroEntropy. Also upserts Supabase `documents` + AI `title/summary` when configured.

### POST /api/zeroentropy/sync-to-supabase
Backfill existing ZeroEntropy documents to Supabase in one call.
Body: `{ "limit": 500, "includeAnnotations": true }`

## Diarization Strategy
- Non‑diarized first pass (AssemblyAI) to get a clean transcript
- LLM classification (OpenAI) to decide single vs multi speaker (text-only heuristic)
- If multi, diarized pass with backend smoothing:
  - Collapse to single when one speaker dominates talk-time
  - Absorb short flip segments
  - Merge adjacent same‑speaker utterances

> more testing needed to be done for multi-speaker conversation


### POST /api/transcribe
Transcribe audio chunks and store in vector database.

**Request:**
```multipart/form-data
audio: audio file (wav/mp3)
recordingId: string
```

**Response:**
```json
{
  "transcription": "Transcribed text here",
  "documentId": "uuid",
  "recordingId": "recording-id",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### POST /api/search
Search through stored transcripts using natural language.

**Request:**
```json
{
  "query": "What did I say about the project timeline?",
  "limit": 5
}
```

**Response:**
```json
{
  "results": [
    {
      "id": "uuid",
      "text": "Relevant transcript segment",
      "timestamp": "2024-01-01T00:00:00Z",
      "recordingId": "recording-id",
      "score": 0.92
    }
  ],
  "answer": "Based on your recordings, you mentioned...",
  "query": "Original query",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### GET /api/transcripts/recent
Get recent transcript entries.

**Query Parameters:**
- `limit`: Number of results (default: 10)

## Example Query Flow

### User Journey: "What did I say about X last week?"

1. **User Input**: Types query in Chat screen
2. **API Call**: Mobile app sends POST to `/api/search`
3. **Embedding Generation**: ZeroEntropy creates query embedding
4. **Vector Search**: Searches vector database for similar content
5. **Results Retrieval**: Top-N relevant segments retrieved
6. **Answer Generation**: RAG pipeline generates contextual answer
7. **Response Display**: Chat UI shows answer + source segments

### Data Flow Example:

```javascript
// 1. Audio chunk received from BLE device
const audioChunk = new ArrayBuffer(32000);

// 2. Send to backend for transcription
const response = await fetch('http://localhost:3000/api/transcribe', {
  method: 'POST',
  body: formData // contains audio chunk
});

// 3. Backend processes with Whisper
const transcription = "Discussed the Q4 roadmap and key milestones";

// 4. Store in ZeroEntropy with metadata
const document = {
  text: transcription,
  metadata: {
    recordingId: "rec-123",
    timestamp: "2024-01-01T10:00:00Z"
  }
};

// 5. User searches: "What about the roadmap?"
const searchResults = await zeroEntropy.search("What about the roadmap?");

// 6. Return relevant segments with scores
{
  results: [{
    text: "Discussed the Q4 roadmap and key milestones",
    score: 0.95
  }],
  answer: "You discussed the Q4 roadmap and mentioned key milestones."
}
```

## Development Notes

### Extending the System

1. **Real BLE Implementation**: Replace simulated BLE service with actual `react-native-ble-plx` implementation
2. **Advanced RAG Features**: Add memory context windows, conversation threading
3. **User Management**: Add authentication and multi-user support
4. **Export Functionality**: Add ability to export transcripts to various formats
5. **Voice Commands**: Add voice-activated recording and commands

### Architecture Decisions

- **Chunked Audio Processing**: Enables real-time transcription without waiting for full recording
- **Vector Storage**: Semantic search superior to keyword matching for conversational data
- **Simulated BLE**: Allows development without hardware dependency
- **TypeScript**: Type safety across full stack reduces runtime errors

## Troubleshooting

### Common Issues

1. **Network request failed (Expo on physical device)**:
   - Ensure the backend is running: `cd backend && npm run dev`
   - Phone and Mac must be on the same Wi‑Fi network
   - Set `EXPO_PUBLIC_API_URL` to `http://<YOUR_MAC_LAN_IP>:3000` (in `mobile/.env` or via CLI)
   - Start Expo in LAN mode and clear cache if needed:
     ```bash
     EXPO_PUBLIC_API_URL=http://<YOUR_MAC_LAN_IP>:3000 npx expo start --lan --clear
     ```
   - Open `http://<YOUR_MAC_LAN_IP>:3000/health` from the phone’s browser to confirm reachability
   - If your network blocks LAN discovery, try Tunnel mode: `npx expo start --tunnel`

2. **Transcription returns simulated data**:
   - Verify OpenAI API key is set correctly
   - Check API key has Whisper access

3. **ZeroEntropy endpoints fail or fall back to mock**:
   - Check `backend/.env` for `ZEROENTROPY_API_KEY`
   - Restart backend after changing env: `npm run dev`
   - Verify: `http://<YOUR_MAC_LAN_IP>:3000/api/zeroentropy/status`

4. **"npm run dev" says missing script**:
   - You likely ran it at the repo root. Change into the correct directory first:
     - Backend: `cd backend && npm run dev`
     - Mobile: `cd mobile && npx expo start`

5. **iOS Simulator cannot boot (cannot determine the runtime bundle)**:
   - Ensure Xcode is installed and initialized:
     - Install/Update Xcode (App Store)
     - Open Xcode once to finish components install
     - Xcode → Settings → Platforms → ensure an iOS Simulator runtime is installed
   - Point CLI to Xcode and accept license:
     ```bash
     xcode-select -p
     sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
     sudo xcodebuild -license accept
     ```
   - Reset simulators and boot a valid device:
     ```bash
     killall Simulator || true
     killall -9 com.apple.CoreSimulator.CoreSimulatorService || true
     xcrun simctl list runtimes
     xcrun simctl list devices
     open -a Simulator
     # Optional: wipe all
     xcrun simctl erase all
     ```
   - Start Expo and launch iOS:
     ```bash
     cd mobile
     npx expo start --lan
     # press i to open iOS simulator
     ```
     If it still errors, manually boot a listed device:
     ```bash
     xcrun simctl boot "iPhone 15 Pro"
     open -a Simulator
     ```
   - Temporary fallback: run on a physical device with Expo Go:
     ```bash
     npx expo start --lan
     # scan the QR code on your phone
     ```

## License

MIT

## Contributors

Built with Claude Code 🤖