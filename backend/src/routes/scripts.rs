// Core rules: versions are INSERT-only (immutable, no edit/delete path); version numbers are
// allocated as MAX+1 while holding the scripts row lock (`SELECT … FOR UPDATE`, + a UNIQUE
// backstop); every query filters by space_id so cross-space id probing is impossible; flowContent
// gets the "JSON object + 256 KiB" backstop check only. Script ids are client-generated (409
// SCRIPT_EXISTS on collision).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

use crate::db::now_utc;
use crate::dto::{
    CreateScriptReq, CreateScriptVersionReq, ErrorBodyDto, ScriptDto, UpdateScriptReq, VersionDto,
    VersionMetaDto,
};
use crate::error::{is_unique_violation, ApiError, ApiJson};
use crate::spacekey::{
    is_valid_entity_id, parse_version_param, require_space, validate_flow_content,
    validate_script_name, validate_script_note, validate_version_note, write_transaction,
    SpaceKeyHeader,
};
use crate::AppState;

const SCRIPT_LIST_SQL: &str = "SELECT s.id, s.name, s.note, s.updated_at, \
     v.version_number, v.note \
     FROM scripts s \
     LEFT JOIN script_versions v ON v.script_id = s.id \
       AND v.version_number = (SELECT MAX(version_number) FROM script_versions \
                               WHERE script_id = s.id) \
     WHERE s.space_id = $1 ORDER BY s.updated_at DESC, s.id DESC";

const SCRIPT_BY_ID_SQL: &str = "SELECT s.id, s.name, s.note, s.updated_at, \
     v.version_number, v.note \
     FROM scripts s \
     LEFT JOIN script_versions v ON v.script_id = s.id \
       AND v.version_number = (SELECT MAX(version_number) FROM script_versions \
                               WHERE script_id = s.id) \
     WHERE s.id = $1 AND s.space_id = $2";

type ScriptRow = (String, String, String, String, Option<i64>, Option<String>);

fn script_dto(row: ScriptRow) -> ScriptDto {
    ScriptDto {
        id: row.0,
        name: row.1,
        note: row.2,
        updated_at: row.3,
        latest_version_number: row.4.unwrap_or(1),
        latest_version_note: row.5.unwrap_or_default(),
    }
}

fn script_not_found() -> ApiError {
    ApiError::NotFound {
        code: "SCRIPT_NOT_FOUND",
        message: "Script not found".to_string(),
    }
}

/// Create a script: one transaction inserts scripts + script_versions(v1). The script id comes from
/// the client; a duplicate is a 409 SCRIPT_EXISTS, not a silent rebind.
#[utoipa::path(
    post,
    path = "/api/spaces/{spaceId}/scripts",
    tag = "scripts",
    request_body = CreateScriptReq,
    params(("spaceId" = String, Path, description = "Space id")),
    security(("space_key" = [])),
    responses(
        (status = 201, body = ScriptDto),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: id/name/note/version-note shape or flowContent not an object / over the limit"),
        (status = 401, body = ErrorBodyDto, description = "BAD_SPACE_KEY"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND"),
        (status = 409, body = ErrorBodyDto, description = "SCRIPT_EXISTS"),
    )
)]
pub async fn create_script(
    key: SpaceKeyHeader,
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    ApiJson(req): ApiJson<CreateScriptReq>,
) -> Result<(StatusCode, Json<ScriptDto>), ApiError> {
    if !is_valid_entity_id(&req.id) {
        return Err(ApiError::InvalidInput {
            message: "id must be 4–64 characters of [A-Za-z0-9_-]".to_string(),
        });
    }
    let note = req.note.unwrap_or_default();
    let version_note = req.version_note.unwrap_or_default();
    validate_script_name(&req.name)?;
    validate_script_note(&note)?;
    validate_version_note(&version_note)?;
    let content = validate_flow_content(&req.flow_content)?;

    let now = now_utc();
    let mut tx = write_transaction(&state.pool).await?;
    // Re-verify inside the transaction: the space may be deleted between the outer check and this
    // commit (FK cascade); re-checking routes that interleave to 404 instead of a 500 FK violation.
    require_space(&mut *tx, &space_id, &key.0).await?;
    let inserted = sqlx::query(
        "INSERT INTO scripts (id, space_id, name, note, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&req.id)
    .bind(&space_id)
    .bind(req.name.trim())
    .bind(&note)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await;
    if let Err(err) = inserted {
        if is_unique_violation(&err) {
            return Err(ApiError::Conflict {
                code: "SCRIPT_EXISTS",
                message: "A script with this id already exists".to_string(),
            });
        }
        return Err(ApiError::internal(err));
    }
    sqlx::query(
        "INSERT INTO script_versions (script_id, version_number, content, note, created_at) VALUES ($1, 1, $2, $3, $4)",
    )
    .bind(&req.id)
    .bind(&content)
    .bind(&version_note)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;

    Ok((
        StatusCode::CREATED,
        Json(ScriptDto {
            id: req.id,
            name: req.name.trim().to_string(),
            note,
            latest_version_number: 1,
            latest_version_note: version_note,
            updated_at: now,
        }),
    ))
}

/// All script metadata for the space (updatedAt desc); latestVersionNumber is the only server-side
/// support point for the client's "new version available" comparison (pinned versions are local).
#[utoipa::path(
    get,
    path = "/api/spaces/{spaceId}/scripts",
    tag = "scripts",
    params(("spaceId" = String, Path, description = "Space id")),
    security(("space_key" = [])),
    responses(
        (status = 200, body = [ScriptDto]),
        (status = 401, body = ErrorBodyDto, description = "BAD_SPACE_KEY"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND"),
    )
)]
pub async fn list_scripts(
    key: SpaceKeyHeader,
    State(state): State<AppState>,
    Path(space_id): Path<String>,
) -> Result<Json<Vec<ScriptDto>>, ApiError> {
    require_space(&state.pool, &space_id, &key.0).await?;
    let rows = sqlx::query_as::<_, ScriptRow>(SCRIPT_LIST_SQL)
        .bind(&space_id)
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(rows.into_iter().map(script_dto).collect()))
}

/// Rename / edit note: takes effect immediately without creating a version (scripts row only); at
/// least one of name/note must be present.
#[utoipa::path(
    patch,
    path = "/api/spaces/{spaceId}/scripts/{scriptId}",
    tag = "scripts",
    request_body = UpdateScriptReq,
    params(
        ("spaceId" = String, Path, description = "Space id"),
        ("scriptId" = String, Path, description = "Script id"),
    ),
    security(("space_key" = [])),
    responses(
        (status = 200, body = ScriptDto),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: missing fields or length violations"),
        (status = 401, body = ErrorBodyDto, description = "BAD_SPACE_KEY"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND / SCRIPT_NOT_FOUND"),
    )
)]
pub async fn update_script(
    key: SpaceKeyHeader,
    State(state): State<AppState>,
    Path((space_id, script_id)): Path<(String, String)>,
    ApiJson(req): ApiJson<UpdateScriptReq>,
) -> Result<Json<ScriptDto>, ApiError> {
    require_space(&state.pool, &space_id, &key.0).await?;

    let new_name = match &req.name {
        Some(raw) => {
            validate_script_name(raw)?;
            Some(raw.trim().to_string())
        }
        None => None,
    };
    let new_note = match &req.note {
        Some(raw) => {
            validate_script_note(raw)?;
            Some(raw.clone())
        }
        None => None,
    };
    if new_name.is_none() && new_note.is_none() {
        return Err(ApiError::InvalidInput {
            message: "At least one of name or note must be provided".to_string(),
        });
    }

    // UPDATE and the re-read share one transaction: the script may be (cascade-) deleted between
    // the outer check and the write; a missed UPDATE routes to 404 instead of letting the re-read
    // RowNotFound surface as a 500.
    let mut tx = write_transaction(&state.pool).await?;
    require_space(&mut *tx, &space_id, &key.0).await?;
    let done = sqlx::query(
        "UPDATE scripts SET name = COALESCE($1, name), note = COALESCE($2, note), updated_at = $3 \
         WHERE id = $4 AND space_id = $5",
    )
    .bind(new_name)
    .bind(new_note)
    .bind(now_utc())
    .bind(&script_id)
    .bind(&space_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if done.rows_affected() != 1 {
        return Err(script_not_found());
    }

    let row = sqlx::query_as::<_, ScriptRow>(SCRIPT_BY_ID_SQL)
        .bind(&script_id)
        .bind(&space_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(script_not_found)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(script_dto(row)))
}

/// Append an immutable new version: MAX(version_number)+1 allocation + INSERT + scripts.updated_at
/// refresh, all inside one BEGIN IMMEDIATE transaction; the UNIQUE(script_id, version_number)
/// backstop hitting means an invariant broke and is treated as an internal error.
#[utoipa::path(
    post,
    path = "/api/spaces/{spaceId}/scripts/{scriptId}/versions",
    tag = "scripts",
    request_body = CreateScriptVersionReq,
    params(
        ("spaceId" = String, Path, description = "Space id"),
        ("scriptId" = String, Path, description = "Script id"),
    ),
    security(("space_key" = [])),
    responses(
        (status = 201, body = VersionMetaDto),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT"),
        (status = 401, body = ErrorBodyDto, description = "BAD_SPACE_KEY"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND / SCRIPT_NOT_FOUND"),
    )
)]
pub async fn create_script_version(
    key: SpaceKeyHeader,
    State(state): State<AppState>,
    Path((space_id, script_id)): Path<(String, String)>,
    ApiJson(req): ApiJson<CreateScriptVersionReq>,
) -> Result<(StatusCode, Json<VersionMetaDto>), ApiError> {
    require_space(&state.pool, &space_id, &key.0).await?;

    let mut tx = write_transaction(&state.pool).await?;
    // In-transaction re-verification serializes with the version allocation: a concurrent space
    // deletion cannot slip into this commit after the check.
    require_space(&mut *tx, &space_id, &key.0).await?;
    // Take the scripts row lock first: a concurrent version creator for the same script waits
    // here, so the MAX+1 below sees its committed insert (PostgreSQL's replacement for the
    // whole-database BEGIN IMMEDIATE serialization). No row = script missing (or not in this
    // space → 404).
    let locked = sqlx::query("SELECT id FROM scripts WHERE id = $1 AND space_id = $2 FOR UPDATE")
        .bind(&script_id)
        .bind(&space_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if locked.is_none() {
        return Err(script_not_found());
    }
    // A row implies v1 exists (written in the creation transaction, versions are append-only), so
    // MAX never returns NULL in practice.
    let next_version = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(version_number) FROM script_versions WHERE script_id = $1",
    )
    .bind(&script_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?
    .map(|max| max + 1)
    .unwrap_or(1);

    let note = req.version_note.unwrap_or_default();
    validate_version_note(&note)?;
    let content = validate_flow_content(&req.flow_content)?;
    let now = now_utc();

    sqlx::query(
        "INSERT INTO script_versions (script_id, version_number, content, note, created_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&script_id)
    .bind(next_version)
    .bind(&content)
    .bind(&note)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query("UPDATE scripts SET updated_at = $1 WHERE id = $2 AND space_id = $3")
        .bind(&now)
        .bind(&script_id)
        .bind(&space_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;

    Ok((
        StatusCode::CREATED,
        Json(VersionMetaDto {
            version_number: next_version,
            note,
            created_at: now,
        }),
    ))
}

/// Version list (versionNumber desc; the browsing basis for rollback/switch).
#[utoipa::path(
    get,
    path = "/api/spaces/{spaceId}/scripts/{scriptId}/versions",
    tag = "scripts",
    params(
        ("spaceId" = String, Path, description = "Space id"),
        ("scriptId" = String, Path, description = "Script id"),
    ),
    security(("space_key" = [])),
    responses(
        (status = 200, body = [VersionMetaDto]),
        (status = 401, body = ErrorBodyDto, description = "BAD_SPACE_KEY"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND / SCRIPT_NOT_FOUND"),
    )
)]
pub async fn list_script_versions(
    key: SpaceKeyHeader,
    State(state): State<AppState>,
    Path((space_id, script_id)): Path<(String, String)>,
) -> Result<Json<Vec<VersionMetaDto>>, ApiError> {
    require_space(&state.pool, &space_id, &key.0).await?;

    // Filtered by space through the scripts join; an empty result = script missing (every script
    // has v1 and versions are append-only)
    let rows = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT v.version_number, v.note, v.created_at \
         FROM script_versions v \
         JOIN scripts s ON s.id = v.script_id AND s.space_id = $1 \
         WHERE v.script_id = $2 ORDER BY v.version_number DESC",
    )
    .bind(&space_id)
    .bind(&script_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    if rows.is_empty() {
        return Err(script_not_found());
    }
    let items = rows
        .into_iter()
        .map(|(version_number, note, created_at)| VersionMetaDto {
            version_number,
            note,
            created_at,
        })
        .collect();
    Ok(Json(items))
}

/// Fetch one version's full flow content (the immutable snapshot; the single data source for
/// pull/switch/rollback).
#[utoipa::path(
    get,
    path = "/api/spaces/{spaceId}/scripts/{scriptId}/versions/{versionNumber}",
    tag = "scripts",
    params(
        ("spaceId" = String, Path, description = "Space id"),
        ("scriptId" = String, Path, description = "Script id"),
        ("versionNumber" = i64, Path, description = "Version number (positive integer)"),
    ),
    security(("space_key" = [])),
    responses(
        (status = 200, body = VersionDto),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: versionNumber not a positive integer"),
        (status = 401, body = ErrorBodyDto, description = "BAD_SPACE_KEY"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND / SCRIPT_NOT_FOUND / VERSION_NOT_FOUND"),
    )
)]
pub async fn get_script_version(
    key: SpaceKeyHeader,
    State(state): State<AppState>,
    Path((space_id, script_id, version_raw)): Path<(String, String, String)>,
) -> Result<Json<VersionDto>, ApiError> {
    let version_number = parse_version_param(&version_raw, "versionNumber")?;
    require_space(&state.pool, &space_id, &key.0).await?;

    // scripts as the driving row (no row = script missing); LEFT JOIN the version row (all NULL =
    // version missing)
    let row = sqlx::query_as::<_, (Option<i64>, Option<String>, Option<String>, Option<String>)>(
        "SELECT v.version_number, v.note, v.created_at, v.content \
         FROM scripts s \
         LEFT JOIN script_versions v ON v.script_id = s.id AND v.version_number = $1 \
         WHERE s.id = $2 AND s.space_id = $3",
    )
    .bind(version_number)
    .bind(&script_id)
    .bind(&space_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let Some(row) = row else {
        return Err(script_not_found());
    };
    let (Some(version_number), Some(note), Some(created_at), Some(content)) = row else {
        return Err(ApiError::NotFound {
            code: "VERSION_NOT_FOUND",
            message: "Version not found".to_string(),
        });
    };
    let flow_content = serde_json::from_str(&content).map_err(ApiError::internal)?;
    Ok(Json(VersionDto {
        meta: VersionMetaDto {
            version_number,
            note,
            created_at,
        },
        flow_content,
    }))
}
