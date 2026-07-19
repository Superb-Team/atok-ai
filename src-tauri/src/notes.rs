use crate::database::Database;
use crate::models::*;
use tauri::State;

const INTERNAL_JOB_TAG_PREFIX: &str = "atok-internal-job:";

fn processing_job_tag(job_id: &str) -> Result<String, String> {
    let job_id = job_id.trim();
    if job_id.is_empty() || job_id.len() > 128 {
        return Err("Recording processing jobId must contain 1-128 characters".to_string());
    }
    Ok(format!("{}{}", INTERNAL_JOB_TAG_PREFIX, job_id))
}

fn visible_tags(tags: Option<Vec<String>>) -> Option<Vec<String>> {
    tags.map(|values| {
        values
            .into_iter()
            .filter(|tag| !tag.starts_with(INTERNAL_JOB_TAG_PREFIX))
            .collect()
    })
}

fn into_response(note: Note) -> NoteResponse {
    NoteResponse {
        id: note.id,
        title: note.title,
        content: note.content,
        tags: visible_tags(note.tags),
        is_favorite: note.is_favorite,
        is_archived: note.is_archived,
        color: note.color,
        reminder_at: note.reminder_at,
        created_at: note.created_at,
        updated_at: note.updated_at,
    }
}

#[tauri::command]
pub async fn get_notes(
    db: State<'_, Database>,
    user_id: String,
) -> Result<Vec<NoteResponse>, String> {
    let pool = db.get_pool()?;
    let notes = sqlx::query_as::<_, Note>(
        "SELECT * FROM notes 
         WHERE user_id = $1 AND is_deleted = false 
         ORDER BY created_at DESC",
    )
    .bind(&user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch notes: {}", e))?;

    Ok(notes.into_iter().map(into_response).collect())
}

#[tauri::command]
pub async fn get_note(
    db: State<'_, Database>,
    note_id: i32,
    user_id: String,
) -> Result<NoteResponse, String> {
    let pool = db.get_pool()?;
    let note = sqlx::query_as::<_, Note>(
        "SELECT * FROM notes WHERE id = $1 AND user_id = $2 AND is_deleted = false",
    )
    .bind(note_id)
    .bind(&user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch note: {}", e))?
    .ok_or_else(|| "Note not found".to_string())?;

    Ok(into_response(note))
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
         RETURNING *",
    )
    .bind(&user_id)
    .bind(&request.title)
    .bind(&request.content)
    .bind(&request.tags)
    .bind(&request.color)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to create note: {}", e))?;

    Ok(into_response(note))
}

#[tauri::command]
pub async fn create_recording_note(
    db: State<'_, Database>,
    user_id: String,
    job_id: String,
    request: CreateNoteRequest,
) -> Result<NoteResponse, String> {
    let pool = db.get_pool()?;
    let internal_tag = processing_job_tag(&job_id)?;
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("Failed to begin recording note transaction: {}", error))?;

    // PostgreSQL transaction-scoped advisory locking makes the lookup+insert
    // idempotent even when two app processes recover the same recording.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))")
        .bind(&user_id)
        .bind(&job_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to lock recording note job: {}", error))?;

    let existing = sqlx::query_as::<_, Note>(
        "SELECT * FROM notes
         WHERE user_id = $1
           AND COALESCE(tags, ARRAY[]::text[]) @> ARRAY[$2]::text[]
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE",
    )
    .bind(&user_id)
    .bind(&internal_tag)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| format!("Failed to find existing recording note: {}", error))?;

    if let Some(note) = existing {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit recording note lookup: {}", error))?;
        return Ok(into_response(note));
    }

    let mut tags = request.tags.unwrap_or_default();
    tags.retain(|tag| !tag.starts_with(INTERNAL_JOB_TAG_PREFIX));
    tags.push(internal_tag);
    let note = sqlx::query_as::<_, Note>(
        "INSERT INTO notes (user_id, title, content, tags, color)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *",
    )
    .bind(&user_id)
    .bind(&request.title)
    .bind(&request.content)
    .bind(&tags)
    .bind(&request.color)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| format!("Failed to create recording note: {}", error))?;

    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit recording note: {}", error))?;
    Ok(into_response(note))
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
         RETURNING *",
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

    Ok(into_response(note))
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
         WHERE id = $1 AND user_id = $2",
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
         RETURNING *",
    )
    .bind(note_id)
    .bind(&user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to toggle favorite: {}", e))?
    .ok_or_else(|| "Note not found".to_string())?;

    Ok(into_response(note))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_processing_tags_are_not_exposed_to_note_ui() {
        let tags = vec![
            "voice-recording".to_string(),
            "atok-internal-job:job-123".to_string(),
            "transcription".to_string(),
        ];

        assert_eq!(
            visible_tags(Some(tags)),
            Some(vec!["voice-recording".to_string(), "transcription".to_string()])
        );
    }

    #[test]
    fn processing_job_tag_rejects_empty_or_unbounded_ids() {
        assert!(processing_job_tag("").is_err());
        assert!(processing_job_tag(&"x".repeat(129)).is_err());
        assert_eq!(
            processing_job_tag("job-abc").unwrap(),
            "atok-internal-job:job-abc"
        );
    }
}
