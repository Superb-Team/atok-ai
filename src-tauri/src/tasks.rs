use crate::database::Database;
use crate::models::*;
use tauri::State;

#[tauri::command]
pub async fn get_tasks(
    db: State<'_, Database>,
    user_id: String,
) -> Result<Vec<TaskResponse>, String> {
    let pool = db.get_pool()?;
    let tasks = sqlx::query_as::<_, Task>(
        "SELECT * FROM tasks 
         WHERE user_id = $1 AND is_deleted = false 
         ORDER BY position ASC"
    )
    .bind(&user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch tasks: {}", e))?;
    
    Ok(tasks.into_iter().map(|task| TaskResponse {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        duration_minutes: task.duration_minutes,
        tags: task.tags,
        due_date: task.due_date,
        completed_at: task.completed_at,
        position: task.position,
        created_at: task.created_at,
        updated_at: task.updated_at,
    }).collect())
}

#[tauri::command]
pub async fn create_task(
    db: State<'_, Database>,
    user_id: String,
    request: CreateTaskRequest,
) -> Result<TaskResponse, String> {
    let pool = db.get_pool()?;
    let task = sqlx::query_as::<_, Task>(
        "INSERT INTO tasks (user_id, title, description, status, priority, duration_minutes, tags, due_date, position) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
         RETURNING *"
    )
    .bind(&user_id)
    .bind(&request.title)
    .bind(&request.description)
    .bind(&request.status)
    .bind(&request.priority)
    .bind(request.duration_minutes)
    .bind(&request.tags)
    .bind(request.due_date)
    .bind(0) // Default position
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to create task: {}", e))?;
    
    Ok(TaskResponse {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        duration_minutes: task.duration_minutes,
        tags: task.tags,
        due_date: task.due_date,
        completed_at: task.completed_at,
        position: task.position,
        created_at: task.created_at,
        updated_at: task.updated_at,
    })
}

#[tauri::command]
pub async fn update_task(
    db: State<'_, Database>,
    user_id: String,
    request: UpdateTaskRequest,
) -> Result<TaskResponse, String> {
    let pool = db.get_pool()?;
    let task = sqlx::query_as::<_, Task>(
        "UPDATE tasks 
         SET title = COALESCE($1, title),
             description = COALESCE($2, description),
             status = COALESCE($3, status),
             priority = COALESCE($4, priority),
             duration_minutes = COALESCE($5, duration_minutes),
             tags = COALESCE($6, tags),
             due_date = COALESCE($7, due_date),
             position = COALESCE($8, position),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $9 AND user_id = $10
         RETURNING *"
    )
    .bind(&request.title)
    .bind(&request.description)
    .bind(&request.status)
    .bind(&request.priority)
    .bind(request.duration_minutes)
    .bind(&request.tags)
    .bind(request.due_date)
    .bind(request.position)
    .bind(request.id)
    .bind(&user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to update task: {}", e))?
    .ok_or_else(|| "Task not found".to_string())?;
    
    Ok(TaskResponse {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        duration_minutes: task.duration_minutes,
        tags: task.tags,
        due_date: task.due_date,
        completed_at: task.completed_at,
        position: task.position,
        created_at: task.created_at,
        updated_at: task.updated_at,
    })
}

#[tauri::command]
pub async fn delete_task(
    db: State<'_, Database>,
    task_id: i32,
    user_id: String,
) -> Result<MessageResponse, String> {
    let pool = db.get_pool()?;
    let result = sqlx::query(
        "UPDATE tasks SET is_deleted = true 
         WHERE id = $1 AND user_id = $2"
    )
    .bind(task_id)
    .bind(&user_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to delete task: {}", e))?;
    
    if result.rows_affected() == 0 {
        return Err("Task not found".to_string());
    }
    
    Ok(MessageResponse {
        message: "Task deleted successfully".to_string(),
    })
}

#[tauri::command]
pub async fn toggle_task_completion(
    db: State<'_, Database>,
    task_id: i32,
    user_id: String,
) -> Result<TaskResponse, String> {
    let pool = db.get_pool()?;
    // Get current task
    let current_task = sqlx::query_as::<_, Task>(
        "SELECT * FROM tasks WHERE id = $1 AND user_id = $2"
    )
    .bind(task_id)
    .bind(&user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch task: {}", e))?
    .ok_or_else(|| "Task not found".to_string())?;
    
    // Toggle completion
    let new_completed_at = if current_task.completed_at.is_some() {
        None
    } else {
        Some(chrono::Utc::now())
    };
    
    let task = sqlx::query_as::<_, Task>(
        "UPDATE tasks 
         SET completed_at = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 AND user_id = $3
         RETURNING *"
    )
    .bind(new_completed_at)
    .bind(task_id)
    .bind(&user_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to toggle task completion: {}", e))?;
    
    Ok(TaskResponse {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        duration_minutes: task.duration_minutes,
        tags: task.tags,
        due_date: task.due_date,
        completed_at: task.completed_at,
        position: task.position,
        created_at: task.created_at,
        updated_at: task.updated_at,
    })
}

#[tauri::command]
pub async fn update_task_positions(
    db: State<'_, Database>,
    user_id: String,
    updates: Vec<TaskPositionUpdate>,
) -> Result<MessageResponse, String> {
    let pool = db.get_pool()?;
    for update in updates {
        sqlx::query(
            "UPDATE tasks 
             SET position = $1, status = $2, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $3 AND user_id = $4"
        )
        .bind(update.position)
        .bind(&update.status)
        .bind(update.id)
        .bind(&user_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to update task position: {}", e))?;
    }
    
    Ok(MessageResponse {
        message: "Task positions updated successfully".to_string(),
    })
}

#[tauri::command]
pub async fn clear_column_tasks(
    db: State<'_, Database>,
    user_id: String,
    status: String,
) -> Result<MessageResponse, String> {
    let pool = db.get_pool()?;
    sqlx::query(
        "UPDATE tasks SET is_deleted = true 
         WHERE user_id = $1 AND status = $2"
    )
    .bind(&user_id)
    .bind(&status)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to clear tasks: {}", e))?;
    
    Ok(MessageResponse {
        message: "Tasks cleared successfully".to_string(),
    })
}
