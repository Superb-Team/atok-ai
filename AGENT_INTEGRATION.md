# Agent API Integration

## Overview
Chat interface sekarang terintegrasi dengan Agent API untuk conversational AI yang dapat mengakses notes, tasks, dan knowledge base.

## Configuration

### API Settings
File: `src/config/agent.config.ts`

```typescript
export const AGENT_CONFIG = {
  API_BASE_URL: 'http://localhost:8000',
  API_KEY: 'buwf923g231djewqbndi72e2y1v1ok',
  ENDPOINTS: {
    STREAM: '/agent/stream',
    INVOKE: '/agent/invoke',
    HEALTH: '/health',
  },
};
```

## Features

### 1. Conversational Chat
- Percakapan sebelumnya dikirim sebagai context
- Agent dapat mengingat percakapan sebelumnya
- Streaming response untuk UX yang lebih baik

### 2. User Isolation
- Setiap request menggunakan `user_id` dari user yang login
- Data notes dan tasks per-user

### 3. Agent Capabilities
Agent dapat:
- **Task Management**: Create, list, update, complete tasks
- **Note Search**: Search through user's notes
- **Knowledge Base**: Access OpenSearch for RAG
- **Conversational**: Remember context from previous messages

## Usage Examples

### Example 1: Task Management
```
User: "Create a task to review PR #42"
Agent: "I've created a task 'Review PR #42' for you."

User: "Show all my tasks"
Agent: "Here are your tasks: 1. Review PR #42 (backlog)..."

User: "Complete task #1"
Agent: "Task #1 has been marked as complete."
```

### Example 2: Note Search
```
User: "Find notes about authentication"
Agent: "I found 2 notes about authentication: ..."

User: "What did I write about JWT?"
Agent: "In your notes, you mentioned..."
```

### Example 3: Knowledge Base
```
User: "What were the action items from yesterday's meeting?"
Agent: "Based on your meeting notes, the action items were..."
```

## API Request Format

### Streaming Request
```typescript
{
  prompt: "User's message",
  user_id: "user_0024c8",
  conversation_history: [
    { role: "user", content: "Previous message" },
    { role: "assistant", content: "Previous response" }
  ]
}
```

### Response Format (SSE)
```
data: {"type": "content", "content": "Hello"}
data: {"type": "content", "content": " world"}
data: [DONE]
```

## Error Handling

### Common Errors

1. **API Not Running**
   - Error: "Failed to fetch"
   - Solution: Start agent API: `python src/main.py`

2. **Invalid API Key**
   - Error: "403 Forbidden"
   - Solution: Check API key in `agent.config.ts`

3. **User Not Authenticated**
   - Error: "User not authenticated"
   - Solution: Login first

## Development

### Testing Agent API
```bash
# Start agent API
cd path/to/agent-api
python src/main.py

# Test health check
curl http://localhost:8000/health

# Test agent endpoint
curl -X POST http://localhost:8000/agent/invoke \
  -H "Content-Type: application/json" \
  -H "X-API-Key: buwf923g231djewqbndi72e2y1v1ok" \
  -d '{"prompt": "Hello", "user_id": "user_0024c8"}'
```

### Debugging
1. Open browser DevTools
2. Check Network tab for API calls
3. Check Console for errors
4. Verify agent API logs

## Architecture

```
┌─────────────────┐
│   Chat UI       │
│  (page.tsx)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Agent Service   │
│ (agent.service) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Agent API     │
│ localhost:8000  │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────┐
│  DB    │ │OpenSearch│
│(Notes, │ │  (RAG)   │
│ Tasks) │ │          │
└────────┘ └──────────┘
```

## Next Steps

1. **Add More Agent Tools**
   - Calendar integration
   - Email integration
   - File management

2. **Improve Context**
   - Limit conversation history
   - Summarize old messages
   - Add system prompts

3. **Add Features**
   - Voice input
   - Image upload
   - Code execution

## Troubleshooting

### Chat not responding?
1. Check if agent API is running: `http://localhost:8000/health`
2. Check browser console for errors
3. Verify API key is correct
4. Check user is logged in

### Slow responses?
1. Agent API might be processing
2. Check agent API logs
3. Verify OpenSearch is running (if using RAG)

### Wrong user data?
1. Verify `user_id` is correct
2. Check if user is logged in
3. Verify database has correct user data

## Support

For issues:
1. Check agent API logs
2. Check browser console
3. Verify configuration
4. Test with Postman first
