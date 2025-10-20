# Voice Recording to RAG Workflow

## Overview
Workflow otomatis yang mengubah voice recording menjadi searchable knowledge dalam sistem RAG (Retrieval-Augmented Generation).

## Complete Workflow

```
┌─────────────────┐
│  Voice Record   │
│   (MP3 Audio)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Transcribe    │
│   + Enhance     │ ← Agent API
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Save to Notes  │ ← PostgreSQL
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Insert to RAG  │ ← OpenSearch
└─────────────────┘
```

## Step-by-Step Process

### Step 1: Record Audio
User records audio using Recording Popup:
- Click "RECORD" to start
- Click "STOP" or "FINISH" to end recording
- Audio saved as MP3 file

### Step 2: Transcribe & Enhance
Audio file sent to Agent API:
```typescript
POST http://localhost:8000/transcribe-enhance
Headers:
  X-API-Key: buwf923g231djewqbndi72e2y1v1ok
Body (form-data):
  file: recording.mp3
  context: voice recording

Response:
{
  "transcription": "raw transcription text",
  "enhanced_text": "cleaned and formatted text"
}
```

**What happens:**
- Audio transcribed using Whisper AI
- Text enhanced and formatted by LLM
- Punctuation, capitalization, and structure improved

### Step 3: Save to Notes
Enhanced text saved as note in PostgreSQL:
```typescript
{
  title: "Voice Recording - 2024-01-15",
  content: enhanced_text,
  tags: ["voice-recording", "transcription"],
  color: "#E0F2FE",
  user_id: user.id
}
```

**Benefits:**
- Permanent storage in database
- Searchable in notes list
- Can be edited later
- Tagged for easy filtering

### Step 4: Insert to RAG
Text inserted to OpenSearch for AI search:
```typescript
POST http://localhost:8000/opensearch/document/insert
Headers:
  X-API-Key: buwf923g231djewqbndi72e2y1v1ok
  Content-Type: application/json
Body:
{
  "user_id": "user_0024c8",
  "text": enhanced_text,
  "metadata": {
    "type": "voice_recording",
    "date": "2024-01-15",
    "source": "audio_transcription"
  }
}
```

**Benefits:**
- AI can search through voice recordings
- Semantic search enabled
- Context-aware retrieval
- Integrated with agent responses

## Implementation

### Agent Service Functions

#### `transcribeAndEnhance(audioFile, context)`
Transcribe and enhance audio file.

**Parameters:**
- `audioFile: File` - MP3 audio file
- `context?: string` - Optional context (e.g., "meeting notes")

**Returns:** `Promise<string>` - Enhanced text

**Example:**
```typescript
const audioFile = new File([audioBlob], 'recording.mp3');
const text = await agentService.transcribeAndEnhance(audioFile, 'voice recording');
```

#### `insertDocument(userId, text, metadata)`
Insert document to OpenSearch.

**Parameters:**
- `userId: string` - User ID
- `text: string` - Document text
- `metadata?: object` - Optional metadata

**Returns:** `Promise<boolean>` - Success status

**Example:**
```typescript
await agentService.insertDocument(user.id, text, {
  type: 'voice_recording',
  date: '2024-01-15',
});
```

### Recording Popup Integration

#### `processRecording(audioPath)`
Complete workflow from audio file to RAG.

**Process:**
1. Read audio file from path
2. Convert to File object
3. Transcribe and enhance
4. Save to notes database
5. Insert to OpenSearch RAG
6. Show success notification

**Triggered by:**
- Clicking "STOP" button
- Clicking "FINISH" button

## User Experience

### Recording Flow
1. User opens recording popup
2. Clicks "RECORD"
3. Speaks into microphone
4. Clicks "STOP" or "FINISH"
5. Sees "Processing audio..." notification
6. Sees success notification with note title
7. Recording available in:
   - Notes list (as new note)
   - AI Search (via RAG)

### Success Notification
```
✅ Recording processed successfully!

📝 Note created: "Voice Recording - 2024-01-15"
🔍 Added to knowledge base for AI search
```

## AI Search Integration

### How It Works
Once recording is in RAG, AI can search it:

**User asks:**
```
"What did I say about the project timeline?"
```

**Agent searches:**
- Queries OpenSearch with semantic search
- Finds relevant voice recording
- Returns context from transcription

**Agent responds:**
```
Based on your voice recording from 2024-01-15, you mentioned:
"The project timeline is 3 months, with milestone reviews every 2 weeks..."
```

## Error Handling

### Transcription Failed
```typescript
try {
  const text = await agentService.transcribeAndEnhance(audioFile);
} catch (error) {
  alert('Failed to transcribe audio. Please try again.');
  // Audio file still saved, can retry later
}
```

### Note Creation Failed
```typescript
try {
  await noteService.createNote(user.id, newNote);
} catch (error) {
  alert('Failed to save note. Text: ' + enhancedText);
  // User can manually copy text
}
```

### RAG Insertion Failed
```typescript
try {
  await agentService.insertDocument(user.id, text, metadata);
} catch (error) {
  console.error('Failed to insert to RAG:', error);
  // Note still saved, RAG can be updated later
}
```

## Performance Considerations

### Processing Time
- **Transcription**: 5-15 seconds (depends on audio length)
- **Enhancement**: 2-5 seconds
- **Note creation**: < 1 second
- **RAG insertion**: < 1 second
- **Total**: ~10-20 seconds for 1-minute audio

### Optimization
- Processing runs in background
- User can close popup immediately
- Notifications show progress
- No UI blocking

## Testing

### Manual Test
1. Open recording popup
2. Record 10-second audio
3. Click "STOP"
4. Wait for processing
5. Check notes list for new note
6. Ask AI: "What did I just record?"
7. Verify AI can find the recording

### Verify Note Created
```sql
SELECT * FROM notes 
WHERE tags @> ARRAY['voice-recording']
ORDER BY created_at DESC 
LIMIT 1;
```

### Verify RAG Insertion
```bash
curl -X POST http://localhost:8000/opensearch/search \
  -H "X-API-Key: buwf923g231djewqbndi72e2y1v1ok" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user_0024c8",
    "query": "voice recording",
    "limit": 5
  }'
```

## Troubleshooting

### Audio File Not Found
**Problem**: Cannot read audio file after recording

**Solution**:
- Check recording service saves file correctly
- Verify file path is absolute
- Check file permissions

### Transcription Returns Empty
**Problem**: Transcription API returns empty text

**Solution**:
- Check audio file is valid MP3
- Verify audio has actual speech
- Check API key is correct
- Verify Agent API is running

### Note Not Appearing
**Problem**: Note created but not visible in UI

**Solution**:
- Refresh notes list
- Check user_id matches
- Verify database connection
- Check note filters (archived, deleted)

### RAG Search Not Working
**Problem**: AI cannot find voice recordings

**Solution**:
- Verify OpenSearch collection exists
- Check document was inserted
- Test with direct search API
- Verify user_id isolation

## Future Enhancements

### 1. Real-time Transcription
- Show transcription as user speaks
- Live preview of text
- Edit before saving

### 2. Speaker Identification
- Detect multiple speakers
- Label speakers in transcript
- Separate by speaker

### 3. Summary Generation
- Auto-generate summary
- Extract key points
- Create action items

### 4. Language Detection
- Auto-detect language
- Support multiple languages
- Translate if needed

### 5. Audio Playback
- Play audio from note
- Sync text with audio
- Highlight current word

## Security

### Audio File Storage
- Files stored locally
- Not uploaded to cloud
- Deleted after processing (optional)

### API Key Protection
- API key in config file
- Not exposed to user
- Sent in headers only

### User Isolation
- Each user's recordings separate
- RAG collection per-user
- Notes filtered by user_id

## Configuration

### API Settings
File: `src/config/agent.config.ts`

```typescript
export const AGENT_CONFIG = {
  API_BASE_URL: 'http://localhost:8000',
  API_KEY: 'buwf923g231djewqbndi72e2y1v1ok',
  ENDPOINTS: {
    TRANSCRIBE: '/transcribe-enhance',
    DOCUMENT_INSERT: '/opensearch/document/insert',
  },
};
```

### Recording Settings
- Format: MP3
- Sample Rate: 44.1kHz
- Bitrate: 128kbps
- Channels: Mono

## Summary

Voice Recording to RAG workflow provides seamless integration between voice input and AI-powered search. Users can speak naturally, and their words become searchable knowledge that the AI agent can reference in future conversations.

**Key Benefits:**
- ✅ Hands-free note taking
- ✅ Automatic transcription
- ✅ Enhanced formatting
- ✅ Searchable by AI
- ✅ Permanent storage
- ✅ Context-aware retrieval
