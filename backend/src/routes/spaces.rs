// Space lifecycle: register (client-generated id + key, idempotent per key), read (join
// verification) and delete (cascades scripts + versions). No accounts — access is the key.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

use crate::db::now_utc;
use crate::dto::{CreateSpaceReq, ErrorBodyDto, SpaceDto};
use crate::error::{is_unique_violation, ApiError, ApiJson};
use crate::spacekey::{
    is_valid_entity_id, require_space, sha256_hex, validate_space_name, write_transaction,
    SpaceKeyHeader,
};
use crate::AppState;

fn space_not_found() -> ApiError {
    ApiError::NotFound {
        code: "SPACE_NOT_FOUND",
        message: "Space not found".to_string(),
    }
}

/// Register a space: 201 on first registration; 200 (idempotent) when the id already exists under
/// the same key; 409 SPACE_KEY_MISMATCH when it exists under a different key.
#[utoipa::path(
    post,
    path = "/api/spaces",
    tag = "spaces",
    request_body = CreateSpaceReq,
    responses(
        (status = 201, body = SpaceDto, description = "Space registered"),
        (status = 200, body = SpaceDto, description = "Idempotent re-registration with the same key"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: id/key shape or name length"),
        (status = 409, body = ErrorBodyDto, description = "SPACE_KEY_MISMATCH"),
    )
)]
pub async fn create_space(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<CreateSpaceReq>,
) -> Result<(StatusCode, Json<SpaceDto>), ApiError> {
    if !is_valid_entity_id(&req.id) {
        return Err(ApiError::InvalidInput {
            message: "id must be 4–64 characters of [A-Za-z0-9_-]".to_string(),
        });
    }
    if !(16..=256).contains(&req.key.len()) || req.key.chars().any(char::is_whitespace) {
        return Err(ApiError::InvalidInput {
            message: "key must be 16–256 characters without whitespace".to_string(),
        });
    }
    validate_space_name(&req.name)?;

    let key_hash = sha256_hex(req.key.as_bytes());
    let mut tx = write_transaction(&state.pool).await?;
    let existing = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, name, created_at FROM spaces WHERE id = $1",
    )
    .bind(&req.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if let Some((id, name, created_at)) = existing {
        // Idempotent only under the same key; a different key on the same id is a collision
        let stored_hash =
            sqlx::query_scalar::<_, String>("SELECT key_hash FROM spaces WHERE id = $1")
                .bind(&req.id)
                .fetch_one(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
        tx.commit().await.map_err(ApiError::internal)?;
        if stored_hash != key_hash {
            return Err(ApiError::Conflict {
                code: "SPACE_KEY_MISMATCH",
                message: "A space with this id already exists under a different key".to_string(),
            });
        }
        return Ok((
            StatusCode::OK,
            Json(SpaceDto {
                id,
                name,
                created_at,
            }),
        ));
    }

    let now = now_utc();
    let inserted =
        sqlx::query("INSERT INTO spaces (id, key_hash, name, created_at) VALUES ($1, $2, $3, $4)")
            .bind(&req.id)
            .bind(&key_hash)
            .bind(req.name.trim())
            .bind(&now)
            .execute(&mut *tx)
            .await;
    match inserted {
        Ok(_) => {
            tx.commit().await.map_err(ApiError::internal)?;
        }
        // A concurrent registration won the id between our SELECT and INSERT: the failed statement
        // aborts the transaction, so decide on the committed row outside of it (same-key → the
        // idempotent 200 below, different key → SPACE_KEY_MISMATCH).
        Err(err) if is_unique_violation(&err) => {
            tx.rollback().await.map_err(ApiError::internal)?;
            let row = sqlx::query_as::<_, (String, String, String)>(
                "SELECT id, name, created_at FROM spaces WHERE id = $1",
            )
            .bind(&req.id)
            .fetch_optional(&state.pool)
            .await
            .map_err(ApiError::internal)?
            .ok_or_else(|| ApiError::Conflict {
                code: "SPACE_KEY_MISMATCH",
                message: "A space with this id already exists under a different key".to_string(),
            })?;
            let stored_hash =
                sqlx::query_scalar::<_, String>("SELECT key_hash FROM spaces WHERE id = $1")
                    .bind(&req.id)
                    .fetch_one(&state.pool)
                    .await
                    .map_err(ApiError::internal)?;
            if stored_hash != key_hash {
                return Err(ApiError::Conflict {
                    code: "SPACE_KEY_MISMATCH",
                    message: "A space with this id already exists under a different key"
                        .to_string(),
                });
            }
            return Ok((
                StatusCode::OK,
                Json(SpaceDto {
                    id: row.0,
                    name: row.1,
                    created_at: row.2,
                }),
            ));
        }
        Err(err) => return Err(ApiError::internal(err)),
    }

    Ok((
        StatusCode::CREATED,
        Json(SpaceDto {
            id: req.id,
            name: req.name.trim().to_string(),
            created_at: now,
        }),
    ))
}

/// Read one space — the join verification endpoint (a code is only remembered client-side after
/// this succeeds).
#[utoipa::path(
    get,
    path = "/api/spaces/{spaceId}",
    tag = "spaces",
    params(("spaceId" = String, Path, description = "Space id")),
    security(("space_key" = [])),
    responses(
        (status = 200, body = SpaceDto),
        (status = 401, body = ErrorBodyDto, description = "BAD_SPACE_KEY"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND"),
    )
)]
pub async fn get_space(
    _key: SpaceKeyHeader,
    State(state): State<AppState>,
    Path(space_id): Path<String>,
) -> Result<Json<SpaceDto>, ApiError> {
    require_space(&state.pool, &space_id, &_key.0).await?;
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, name, created_at FROM spaces WHERE id = $1",
    )
    .bind(&space_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let (id, name, created_at) = row.ok_or_else(space_not_found)?;
    Ok(Json(SpaceDto {
        id,
        name,
        created_at,
    }))
}

/// Delete a space (cascades scripts + versions). Holders of the code keep whatever they already
/// pulled to their devices.
#[utoipa::path(
    delete,
    path = "/api/spaces/{spaceId}",
    tag = "spaces",
    params(("spaceId" = String, Path, description = "Space id")),
    security(("space_key" = [])),
    responses(
        (status = 204),
        (status = 401, body = ErrorBodyDto, description = "BAD_SPACE_KEY"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND"),
    )
)]
pub async fn delete_space(
    _key: SpaceKeyHeader,
    State(state): State<AppState>,
    Path(space_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let mut tx = write_transaction(&state.pool).await?;
    require_space(&mut *tx, &space_id, &_key.0).await?;
    let done = sqlx::query("DELETE FROM spaces WHERE id = $1")
        .bind(&space_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if done.rows_affected() != 1 {
        return Err(space_not_found());
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/health",
    tag = "ops",
    responses((status = 200, description = "Liveness probe", body = crate::dto::HealthDto))
)]
pub async fn get_health() -> Json<crate::dto::HealthDto> {
    Json(crate::dto::HealthDto {
        status: "ok".to_string(),
    })
}
