// Space lifecycle: register (client-generated id; key-addressed or organization-bound),
// read (join verification) and delete (cascades scripts + versions; org-bound additionally
// cascades the Herald organization and outstanding invites).

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::Json;

use crate::db::now_utc;
use crate::dto::{CreateSpaceReq, ErrorBodyDto, SpaceDto};
use crate::error::{auth_unavailable, is_unique_violation, ApiError, ApiJson};
use crate::orgs::{map_org_error, tier_to_role, OrgApiError};
use crate::spacekey::{
    is_valid_entity_id, require_space_access, require_space_row, sha256_hex, validate_space_name,
    write_transaction, ResolvedIdentity, SpaceAccess, SpaceCategory, SpaceKeyHeader,
};
use crate::AppState;

fn space_not_found() -> ApiError {
    ApiError::NotFound {
        code: "SPACE_NOT_FOUND",
        message: "Space not found".to_string(),
    }
}

fn key_mismatch() -> ApiError {
    ApiError::Conflict {
        code: "SPACE_KEY_MISMATCH",
        message: "A space with this id already exists under a different key".to_string(),
    }
}

/// An org-bound row already owning this id: a member converges on the idempotent 200 (with
/// their actual role), anyone else gets the get_space denial — no id probing beyond
/// membership.
async fn org_space_replay(
    org: &crate::orgs::OrgClient,
    identity: &ResolvedIdentity,
    space_id: &str,
    name: String,
    created_at: String,
    org_id: &str,
) -> Result<(StatusCode, Json<SpaceDto>), ApiError> {
    match org.get_member(org_id, &identity.user_id).await {
        Ok(Some(view)) => {
            let role = tier_to_role(&view.role_name).ok_or_else(auth_unavailable)?;
            Ok((
                StatusCode::OK,
                Json(SpaceDto {
                    id: space_id.to_string(),
                    name,
                    created_at,
                    my_role: Some(role.to_string()),
                    my_user_id: Some(identity.user_id.clone()),
                }),
            ))
        }
        Ok(None) => Err(ApiError::SpaceAccessDenied),
        Err(err) => Err(map_org_error(err)),
    }
}

/// Register a space.
///
/// Key-addressed: 201 on first registration; 200 (idempotent) when the id already exists
/// under the same key; 409 SPACE_KEY_MISMATCH under a different key — the pre-existing
/// contract, bit for bit. Without a key (herald mode): an organization-bound space whose
/// creator becomes the owner, created atomically (a Herald failure rolls the whole thing
/// back — no half-made space).
#[utoipa::path(
    post,
    path = "/api/spaces",
    tag = "spaces",
    request_body = CreateSpaceReq,
    // Key-addressed path: bearer gate (herald mode) with the space key in the body;
    // org-bound path: bearer only. AUTH_MODE=none requires no sign-in and always takes the
    // key-addressed path.
    security(
        ("bearer_auth" = []),
        ("bearer_auth" = [], "space_key" = []),
        ("space_key" = []),
    ),
    responses(
        (status = 201, body = SpaceDto, description = "Space registered (org-bound creation responds with myRole=\"owner\" + myUserId)"),
        (status = 200, body = SpaceDto, description = "Idempotent re-registration (same key, or org-bound by a member)"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: id/key shape, name length, or key-less creation in none mode"),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED (herald mode: no valid sign-in)"),
        (status = 403, body = ErrorBodyDto, description = "SPACE_ACCESS_DENIED (org-bound id exists and the caller is not a member)"),
        (status = 409, body = ErrorBodyDto, description = "SPACE_KEY_MISMATCH"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE (herald mode: sign-in or organization service unreachable — fail-closed)"),
    )
)]
pub async fn create_space(
    State(state): State<AppState>,
    identity: Option<Extension<ResolvedIdentity>>,
    ApiJson(req): ApiJson<CreateSpaceReq>,
) -> Result<(StatusCode, Json<SpaceDto>), ApiError> {
    if !is_valid_entity_id(&req.id) {
        return Err(ApiError::InvalidInput {
            message: "id must be 4–64 characters of [A-Za-z0-9_-]".to_string(),
        });
    }
    if let Some(key) = req.key.as_deref() {
        if !(16..=256).contains(&key.len()) || key.chars().any(char::is_whitespace) {
            return Err(ApiError::InvalidInput {
                message: "key must be 16–256 characters without whitespace".to_string(),
            });
        }
    }
    validate_space_name(&req.name)?;

    match req.key {
        Some(key) => create_key_space(&state, &req.id, &key, &req.name).await,
        None => create_org_space(&state, identity.as_deref(), &req.id, req.name).await,
    }
}

async fn create_key_space(
    state: &AppState,
    space_id: &str,
    key: &str,
    name: &str,
) -> Result<(StatusCode, Json<SpaceDto>), ApiError> {
    let key_hash = sha256_hex(key.as_bytes());
    let mut tx = write_transaction(&state.pool).await?;
    let existing = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, name, created_at FROM spaces WHERE id = $1",
    )
    .bind(space_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if let Some((id, name, created_at)) = existing {
        // Idempotent only under the same key; a different key on the same id is a collision
        let stored_hash =
            sqlx::query_scalar::<_, Option<String>>("SELECT key_hash FROM spaces WHERE id = $1")
                .bind(space_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(ApiError::internal)?
                // An org-bound row owns this id (key_hash is NULL): entering it is not this
                // key-addressed path's to decide — the same 409 the symmetric direction in
                // create_org_space gives a key-owned id.
                .ok_or_else(key_mismatch)?;
        tx.commit().await.map_err(ApiError::internal)?;
        if stored_hash != key_hash {
            return Err(key_mismatch());
        }
        return Ok((
            StatusCode::OK,
            Json(SpaceDto {
                id,
                name,
                created_at,
                my_role: None,
                my_user_id: None,
            }),
        ));
    }

    let now = now_utc();
    let inserted =
        sqlx::query("INSERT INTO spaces (id, key_hash, name, created_at) VALUES ($1, $2, $3, $4)")
            .bind(space_id)
            .bind(&key_hash)
            .bind(name.trim())
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
            .bind(space_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(ApiError::internal)?
            .ok_or_else(key_mismatch)?;
            let stored_hash = sqlx::query_scalar::<_, Option<String>>(
                "SELECT key_hash FROM spaces WHERE id = $1",
            )
            .bind(space_id)
            .fetch_one(&state.pool)
            .await
            .map_err(ApiError::internal)?
            // The concurrent winner may be an org-bound creation (NULL key_hash).
            .ok_or_else(key_mismatch)?;
            if stored_hash != key_hash {
                return Err(key_mismatch());
            }
            return Ok((
                StatusCode::OK,
                Json(SpaceDto {
                    id: row.0,
                    name: row.1,
                    created_at: row.2,
                    my_role: None,
                    my_user_id: None,
                }),
            ));
        }
        Err(err) => return Err(ApiError::internal(err)),
    }

    Ok((
        StatusCode::CREATED,
        Json(SpaceDto {
            id: space_id.to_string(),
            name: name.trim().to_string(),
            created_at: now,
            my_role: None,
            my_user_id: None,
        }),
    ))
}

async fn create_org_space(
    state: &AppState,
    identity: Option<&ResolvedIdentity>,
    space_id: &str,
    name: String,
) -> Result<(StatusCode, Json<SpaceDto>), ApiError> {
    // Key-less creation is the org-bound path and exists only in herald mode; none-mode
    // deployments keep creating key spaces exclusively.
    let Some(org) = state.org.as_ref() else {
        return Err(ApiError::InvalidInput {
            message: "A space key is required when the sign-in mode is disabled".to_string(),
        });
    };
    let Some(identity) = identity else {
        return Err(ApiError::AuthRequired);
    };

    let mut tx = write_transaction(&state.pool).await?;
    let existing = sqlx::query_as::<_, (Option<String>, Option<String>, String, String)>(
        "SELECT key_hash, org_id, name, created_at FROM spaces WHERE id = $1",
    )
    .bind(space_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if let Some((key_hash, org_id, name, created_at)) = existing {
        tx.commit().await.map_err(ApiError::internal)?;
        if let (None, Some(existing_org_id)) = (key_hash, org_id) {
            return org_space_replay(org, identity, space_id, name, created_at, &existing_org_id)
                .await;
        }
        // A key-addressed space already owns this id; entering it requires its key, not this
        // endpoint.
        return Err(key_mismatch());
    }

    // Insert the row first, then register the organization inside the same transaction: the
    // transaction holds only this fresh row (a concurrent same-id insert fails the UNIQUE
    // constraint before any Herald call), and any Herald failure rolls the whole creation
    // back — a committed space is always a complete one.
    let now = now_utc();
    let inserted = sqlx::query(
        "INSERT INTO spaces (id, key_hash, org_id, name, created_at) VALUES ($1, NULL, NULL, $2, $3)",
    )
    .bind(space_id)
    .bind(name.trim())
    .bind(&now)
    .execute(&mut *tx)
    .await;
    if let Err(err) = inserted {
        if is_unique_violation(&err) {
            // A concurrent org-bound creation won the id; decide on its committed row
            // outside the aborted transaction (member → idempotent 200, anyone else → denied).
            let row = sqlx::query_as::<_, (Option<String>, Option<String>, String, String)>(
                "SELECT key_hash, org_id, name, created_at FROM spaces WHERE id = $1",
            )
            .bind(space_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(ApiError::internal)?
            .ok_or_else(key_mismatch)?;
            if let (None, Some(existing_org_id)) = (row.0, row.1) {
                return org_space_replay(org, identity, space_id, row.2, row.3, &existing_org_id)
                    .await;
            }
            return Err(key_mismatch());
        }
        return Err(ApiError::internal(err));
    }
    let created = match org
        .create_org(space_id, name.trim(), &identity.user_id)
        .await
    {
        Ok(created) => created,
        // The owner is the freshly gate-authenticated caller; "user not found" here is an
        // out-of-contract answer, not a client error.
        Err(OrgApiError::Upstream { status: 404, .. }) => return Err(auth_unavailable()),
        Err(err) => return Err(map_org_error(err)),
    };
    if created.owner_id != identity.user_id {
        // The organization for this externalId already exists under a different owner (e.g.
        // a leftover from a lost commit): refuse to bind someone else's organization.
        return Err(key_mismatch());
    }
    sqlx::query("UPDATE spaces SET org_id = $1 WHERE id = $2")
        .bind(&created.id)
        .bind(space_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    tracing::info!(action = "create_org_space", space = %space_id, "org-bound space created");

    Ok((
        StatusCode::CREATED,
        Json(SpaceDto {
            id: space_id.to_string(),
            name: name.trim().to_string(),
            created_at: now,
            my_role: Some("owner".to_string()),
            my_user_id: Some(identity.user_id.clone()),
        }),
    ))
}

/// Read one space — the join verification endpoint.
///
/// A code is only remembered client-side after this succeeds. Org-bound spaces need no
/// X-Space-Key (a presented one is ignored) and the response carries myRole/myUserId for
/// members.
#[utoipa::path(
    get,
    path = "/api/spaces/{spaceId}",
    tag = "spaces",
    params(("spaceId" = String, Path, description = "Space id")),
    // Key-addressed space: bearer AND space key (herald mode) or space key only (none mode);
    // org-bound space: bearer only (any member).
    security(
        ("bearer_auth" = [], "space_key" = []),
        ("space_key" = []),
        ("bearer_auth" = []),
    ),
    responses(
        (status = 200, body = SpaceDto, description = "Space data (org-bound members also get myRole + myUserId)"),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED (herald mode) / BAD_SPACE_KEY"),
        (status = 403, body = ErrorBodyDto, description = "SPACE_ACCESS_DENIED (org-bound space, not a member)"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE (herald mode: sign-in or organization service unreachable — fail-closed)"),
    )
)]
pub async fn get_space(
    key: SpaceKeyHeader,
    identity: Option<Extension<ResolvedIdentity>>,
    State(state): State<AppState>,
    Path(space_id): Path<String>,
) -> Result<Json<SpaceDto>, ApiError> {
    let category = require_space_access(
        &state.pool,
        state.org.as_ref(),
        identity.as_deref(),
        &space_id,
        key.0.as_deref(),
        SpaceAccess::Read,
    )
    .await?;
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, name, created_at FROM spaces WHERE id = $1",
    )
    .bind(&space_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let (id, name, created_at) = row.ok_or_else(space_not_found)?;
    match category {
        SpaceCategory::OrgBound { role, .. } => Ok(Json(SpaceDto {
            id,
            name,
            created_at,
            my_role: Some(role.to_string()),
            my_user_id: identity.as_deref().map(|identity| identity.user_id.clone()),
        })),
        SpaceCategory::Key => Ok(Json(SpaceDto {
            id,
            name,
            created_at,
            my_role: None,
            my_user_id: None,
        })),
    }
}

/// Delete a space.
///
/// Key-addressed: holders of the code keep whatever they already pulled to their devices.
/// Org-bound: admin-tier capability; the Herald organization is deleted first (a repeat 404
/// counts as done) and any failure leaves the space fully intact for a retry; the local row
/// delete then cascades scripts, versions and outstanding invites.
#[utoipa::path(
    delete,
    path = "/api/spaces/{spaceId}",
    tag = "spaces",
    params(("spaceId" = String, Path, description = "Space id")),
    // Key-addressed space: bearer AND space key (herald mode) or space key only (none mode);
    // org-bound space: bearer only (admin tier).
    security(
        ("bearer_auth" = [], "space_key" = []),
        ("space_key" = []),
        ("bearer_auth" = []),
    ),
    responses(
        (status = 204),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED (herald mode) / BAD_SPACE_KEY"),
        (status = 403, body = ErrorBodyDto, description = "SPACE_ACCESS_DENIED / SPACE_ROLE_REQUIRED (org-bound space without the admin tier)"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE (herald mode: sign-in or organization service unreachable — fail-closed)"),
    )
)]
pub async fn delete_space(
    key: SpaceKeyHeader,
    identity: Option<Extension<ResolvedIdentity>>,
    State(state): State<AppState>,
    Path(space_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let category = require_space_access(
        &state.pool,
        state.org.as_ref(),
        identity.as_deref(),
        &space_id,
        key.0.as_deref(),
        SpaceAccess::Manage,
    )
    .await?;
    match category {
        SpaceCategory::Key => {
            let mut tx = write_transaction(&state.pool).await?;
            // Local re-verification inside the transaction: the row must still exist and still
            // be the key-addressed row answering to the presented key — a same-id
            // delete-and-recreate interleave (another key → 401, another addressing method →
            // 404) never deletes the new row.
            require_space_row(&mut *tx, &space_id, key.0.as_deref(), None).await?;
            let done = sqlx::query("DELETE FROM spaces WHERE id = $1")
                .bind(&space_id)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
            if done.rows_affected() != 1 {
                return Err(space_not_found());
            }
            tx.commit().await.map_err(ApiError::internal)?;
        }
        SpaceCategory::OrgBound { org_id, .. } => {
            // Herald first and outside any local transaction: a failed organization deletion
            // must leave the space fully intact (fail-closed retry).
            let Some(org) = state.org.as_ref() else {
                return Err(auth_unavailable());
            };
            org.delete_org(&org_id).await.map_err(map_org_error)?;
            let mut tx = write_transaction(&state.pool).await?;
            // The row must still be the org-bound row whose organization was just deleted: a
            // same-id recreate racing this request (another admin finished the deletion and
            // the id was reused) routes to 404 instead of deleting the new row.
            require_space_row(&mut *tx, &space_id, key.0.as_deref(), Some(&org_id)).await?;
            let done = sqlx::query("DELETE FROM spaces WHERE id = $1")
                .bind(&space_id)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
            if done.rows_affected() != 1 {
                return Err(space_not_found());
            }
            tx.commit().await.map_err(ApiError::internal)?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Liveness probe.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// An id owned by an org-bound row is the same collision for key-addressed creation as a
    /// different key: 409 SPACE_KEY_MISMATCH, never a NULL-decode 500 (key_hash is NULL on
    /// org-bound rows).
    #[tokio::test]
    async fn key_creation_against_an_org_bound_owned_id_is_a_409() {
        let pool = crate::db::init_test_pool().await;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migration run failed");
        sqlx::query(
            "INSERT INTO spaces (id, key_hash, org_id, name, created_at) \
             VALUES ('sp-test00000000002', NULL, 'org-test0000000001', 'Org-bound', '2026-01-01T00:00:00.000Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let state = AppState {
            pool,
            auth: None,
            org: None,
        };

        let err = create_key_space(&state, "sp-test00000000002", &"k".repeat(32), "X")
            .await
            .expect_err("an org-bound-owned id is a collision");
        assert!(
            matches!(err, ApiError::Conflict { code, .. } if code == "SPACE_KEY_MISMATCH"),
            "got {err:?}"
        );
    }
}
