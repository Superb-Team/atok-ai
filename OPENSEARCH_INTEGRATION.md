# OpenSearch Collection Auto-Creation

## Overview
Aplikasi secara otomatis membuat OpenSearch collection untuk setiap user baru. Collection ini digunakan untuk RAG (Retrieval-Augmented Generation) agar agent dapat mencari informasi dari notes dan documents user.

## How It Works

### 1. Auto-Creation Triggers
Collection dibuat otomatis saat:
- **User baru login** (via `handleLoginSuccess`)
- **App pertama kali load** dengan user yang sudah login (via `checkAuth`)

### 2. Smart Check
Sebelum membuat collection, sistem akan:
1. Check apakah collection sudah ada: `GET /opensearch/collection/check/{user_id}`
2. Jika belum ada, buat collection baru: `POST /opensearch/collection/create`
3. Jika sudah ada, skip creation

### 3. Background Process
- Collection creation berjalan di background
- Tidak mengganggu user experience
- Error di-log tapi tidak menghentikan aplikasi

## API Endpoints Used

### Check Collection
```typescript
GET http://localhost:8000/opensearch/collection/check/{user_id}
Headers:
  X-API-Key: buwf923g231djewqbndi72e2y1v1ok

Response:
{
  "exists": true,
  "user_id": "user_0024c8",
  "collection_name": "atok_user_0024c8"
}
```

### Create Collection
```typescript
POST http://localhost:8000/opensearch/collection/create
Headers:
  X-API-Key: buwf923g231djewqbndi72e2y1v1ok
  Content-Type: application/json

Body:
{
  "user_id": "user_0024c8"
}

Response:
{
  "success": true,
  "collection_name": "atok_user_0024c8",
  "message": "Collection created successfully"
}
```

## Service Functions

### `agentService.checkCollection(userId)`
Check if collection exists for user.

**Returns**: `Promise<boolean>`
- `true` - Collection exists
- `false` - Collection not found

### `agentService.createCollection(userId)`
Create new collection for user.

**Returns**: `Promise<boolean>`
- `true` - Collection created successfully
- `false` - Failed to create collection

### `agentService.ensureCollection(userId)`
Ensure collection exists, create if not.

**Returns**: `Promise<boolean>`
- `true` - Collection exists or created successfully
- `false` - Failed to ensure collection

## Usage in Application

### On Login
```typescript
const handleLoginSuccess = async () => {
  setIsAuthenticated(true);
  
  const user = authService.getUser();
  if (user) {
    // Auto-create collection
    await agentService.ensureCollection(user.id);
  }
};
```

### On App Load
```typescript
const checkAuth = async () => {
  const token = authService.getToken();
  if (token) {
    await authService.getCurrentUser(token);
    setIsAuthenticated(true);
    
    const user = authService.getUser();
    if (user) {
      // Ensure collection exists
      await agentService.ensureCollection(user.id);
    }
  }
};
```

## Benefits

### 1. Seamless Experience
- User tidak perlu manual create collection
- Collection siap digunakan saat pertama kali login

### 2. RAG Ready
- Agent langsung bisa search documents
- Knowledge base siap digunakan

### 3. Per-User Isolation
- Setiap user punya collection sendiri
- Data terisolasi dan aman

### 4. Idempotent
- Aman dipanggil berkali-kali
- Tidak akan create duplicate collection

## Error Handling

### Collection Creation Failed
```typescript
try {
  await agentService.ensureCollection(userId);
} catch (error) {
  console.error("Failed to ensure collection:", error);
  // App continues to work, RAG features may be limited
}
```

### API Not Available
- Error di-log ke console
- App tetap berfungsi normal
- RAG features tidak available sampai API online

## Testing

### Manual Test
1. Login dengan user baru
2. Check console logs: "Collection not found for user..., creating..."
3. Verify collection created: `GET /opensearch/collection/check/{user_id}`

### Verify Collection
```bash
curl -X GET http://localhost:8000/opensearch/collection/check/user_0024c8 \
  -H "X-API-Key: buwf923g231djewqbndi72e2y1v1ok"
```

### Check Collection Stats
```bash
curl -X GET http://localhost:8000/opensearch/collection/stats/user_0024c8 \
  -H "X-API-Key: buwf923g231djewqbndi72e2y1v1ok"
```

## Troubleshooting

### Collection Not Created
**Problem**: User login tapi collection tidak dibuat

**Solutions**:
1. Check agent API is running: `http://localhost:8000/health`
2. Check API key is correct
3. Check console logs for errors
4. Manually create: `POST /opensearch/collection/create`

### Duplicate Collections
**Problem**: Multiple collections for same user

**Solution**: 
- Tidak mungkin terjadi karena ada check sebelum create
- Jika terjadi, delete duplicate via API

### API Timeout
**Problem**: Collection creation timeout

**Solution**:
- Increase timeout di fetch request
- Check OpenSearch service is running
- Check network connection

## Future Enhancements

### 1. Collection Status UI
- Show collection status in Settings page
- Display document count
- Show last indexed time

### 2. Manual Refresh
- Button to manually refresh collection
- Re-index all documents

### 3. Collection Management
- Delete collection
- Clear all documents
- Export/Import data

### 4. Batch Operations
- Bulk insert documents
- Batch delete
- Bulk update

## Related Features

### Document Insertion
Once collection exists, documents can be inserted:
```typescript
POST /opensearch/document/insert
Body: {
  "user_id": "user_0024c8",
  "text": "Meeting notes...",
  "metadata": {"type": "meeting"}
}
```

### RAG Search
Agent can search documents:
```typescript
POST /agent/invoke
Body: {
  "prompt": "What did we discuss about authentication?",
  "user_id": "user_0024c8"
}
```

## Configuration

### API Settings
File: `src/config/agent.config.ts`

```typescript
export const AGENT_CONFIG = {
  API_BASE_URL: 'http://localhost:8000',
  API_KEY: 'buwf923g231djewqbndi72e2y1v1ok',
  ENDPOINTS: {
    COLLECTION_CHECK: '/opensearch/collection/check',
    COLLECTION_CREATE: '/opensearch/collection/create',
    // ...
  },
};
```

## Security

### API Key Protection
- API key stored in config file
- Not exposed to user
- Sent in header only

### User Isolation
- Collection name includes user_id
- Each user can only access their own collection
- Backend validates user_id

## Performance

### Async Creation
- Collection creation tidak block UI
- Runs in background
- User dapat langsung menggunakan app

### Caching
- Check result bisa di-cache
- Reduce API calls
- Improve performance

## Monitoring

### Console Logs
```
Collection not found for user user_0024c8, creating...
OpenSearch collection created for user: user_0024c8
```

### Error Logs
```
Error checking collection: [error details]
Failed to create collection: [error details]
Failed to ensure collection: [error details]
```

## Summary

OpenSearch collection auto-creation memastikan setiap user memiliki knowledge base yang siap digunakan sejak pertama kali login. Fitur ini berjalan di background, tidak mengganggu user experience, dan membuat RAG features langsung available untuk agent.
