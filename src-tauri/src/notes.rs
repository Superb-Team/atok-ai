use crate::database::Database;
use crate::models::*;
use tauri::State;

#[tauri::command]
pub async fn get_notes(
    db: State<'_, Database>,
    user_id: String,
) -> Result<Vec<NoteResponse>, String> {
    let pool = db.get_pool()?;
    let notes = sqlx::query_as::<_, Note>(
        "SELECT * FROM notes 
         WHERE user_id = $1 AND is_deleted = false 
         ORDER BY created_at DESC"
    )
    .bind(&user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch notes: {}", e))?;
    
    Ok(notes.into_iter().map(|note| NoteResponse {
        id: note.id,
        title: note.title,
        content: note.content,
        tags: note.tags,
        is_favorite: note.is_favorite,
        is_archived: note.is_archived,
        color: note.color,
        reminder_at: note.reminder_at,
        created_at: note.created_at,
        updated_at: note.updated_at,
    }).collect())
}

#[tauri::command]
pub async fn get_note(
    db: State<'_, Database>,
    note_id: i32,
    user_id: String,
) -> Result<NoteResponse, String> {
    let pool = db.get_pool()?;
    let note = sqlx::query_as::<_, Note>(
        "SELECT * FROM notes WHERE id = $1 AND user_id = $2 AND is_deleted = false"
    )
    .bind(note_id)
    .bind(&user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch note: {}", e))?
    .ok_or_else(|| "Note not found".to_string())?;
    
    Ok(NoteResponse {
        id: note.id,
        title: note.title,
        content: note.content,
        tags: note.tags,
        is_favorite: note.is_favorite,
        is_archived: note.is_archived,
        color: note.color,
        reminder_at: note.reminder_at,
        created_at: note.created_at,
        updated_at: note.updated_at,
    })
}

#[tauri::command]
pub async fn create_note(
    db: State<'_, Database>,
    user_id: String,
    request: CreateNoteRequest,
) -> Result<NoteResponse, String> {
    let pool = db.get_pool()?;
    let note = sqlx::query_as::<_, Note>(
        "INSERT INTO notes (user_id, title, content, tags, color) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING *"
    )
    .bind(&user_id)
    .bind(&request.title)
    .bind(&request.content)
    .bind(&request.tags)
    .bind(&request.color)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to create note: {}", e))?;
    
    Ok(NoteResponse {
        id: note.id,
        title: note.title,
        content: note.content,
        tags: note.tags,
        is_favorite: note.is_favorite,
        is_archived: note.is_archived,
        color: note.color,
        reminder_at: note.reminder_at,
        created_at: note.created_at,
        updated_at: note.updated_at,
    })
}

#[tauri::command]
pub async fn update_note(
    db: State<'_, Database>,
    user_id: String,
    request: UpdateNoteRequest,
) -> Result<NoteResponse, String> {
    let pool = db.get_pool()?;
    let note = sqlx::query_as::<_, Note>(
        "UPDATE notes 
         SET title = COALESCE($1, title),
             content = COALESCE($2, content),
             is_favorite = COALESCE($3, is_favorite),
             is_archived = COALESCE($4, is_archived),
             color = COALESCE($5, color),
             tags = COALESCE($6, tags),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $7 AND user_id = $8
         RETURNING *"
    )
    .bind(&request.title)
    .bind(&request.content)
    .bind(request.is_favorite)
    .bind(request.is_archived)
    .bind(&request.color)
    .bind(&request.tags)
    .bind(request.id)
    .bind(&user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to update note: {}", e))?
    .ok_or_else(|| "Note not found".to_string())?;
    
    Ok(NoteResponse {
        id: note.id,
        title: note.title,
        content: note.content,
        tags: note.tags,
        is_favorite: note.is_favorite,
        is_archived: note.is_archived,
        color: note.color,
        reminder_at: note.reminder_at,
        created_at: note.created_at,
        updated_at: note.updated_at,
    })
}

#[tauri::command]
pub async fn delete_note(
    db: State<'_, Database>,
    note_id: i32,
    user_id: String,
) -> Result<MessageResponse, String> {
    let pool = db.get_pool()?;
    let result = sqlx::query(
        "UPDATE notes SET is_deleted = true, deleted_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND user_id = $2"
    )
    .bind(note_id)
    .bind(&user_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to delete note: {}", e))?;
    
    if result.rows_affected() == 0 {
        return Err("Note not found".to_string());
    }
    
    Ok(MessageResponse {
        message: "Note deleted successfully".to_string(),
    })
}

#[tauri::command]
pub async fn toggle_favorite(
    db: State<'_, Database>,
    note_id: i32,
    user_id: String,
) -> Result<NoteResponse, String> {
    let pool = db.get_pool()?;
    let note = sqlx::query_as::<_, Note>(
        "UPDATE notes SET is_favorite = NOT is_favorite, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND user_id = $2 
         RETURNING *"
    )
    .bind(note_id)
    .bind(&user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to toggle favorite: {}", e))?
    .ok_or_else(|| "Note not found".to_string())?;
    
    Ok(NoteResponse {
        id: note.id,
        title: note.title,
        content: note.content,
        tags: note.tags,
        is_favorite: note.is_favorite,
        is_archived: note.is_archived,
        color: note.color,
        reminder_at: note.reminder_at,
        created_at: note.created_at,
        updated_at: note.updated_at,
    })
}
