// Org-bound space member and invite endpoints (herald mode only — routes/mod.rs mounts this
// module exclusively there). Membership and role facts live only in Herald and are proxied
// live: nothing is stored locally and no member identity reaches a log line. The only local
// state is the invite-code hash table. Two spots deliberately hold a database transaction
// across Herald round trips: org-bound creation (the tx holds the freshly inserted space
// row — no other tx can contend for it) and invite redemption (the tx holds the invite row's
// lock — only same-code requests queue behind it). Both trade a bounded hold for "commit
// implies a complete state; failure leaves zero residue and never burns a code".

use std::collections::HashMap;

use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::Json;

use crate::db::{format_utc, now_utc};
use crate::dto::{
    ErrorBodyDto, InviteDto, MemberDto, MemberListDto, RedeemInviteReq, SpaceDto,
    TransferOwnershipReq, UpdateMemberRoleReq,
};
use crate::error::{auth_unavailable, ApiError, ApiJson};
use crate::orgs::{map_org_error, role_to_tier, tier_to_role, OrgClient, TIER_MEMBER, TIER_OWNER};
use crate::spacekey::{
    is_valid_entity_id, org_space_access, require_space_row, sha256_hex, space_org_binding,
    write_transaction, ResolvedIdentity, SpaceAccess,
};
use crate::AppState;

const INVITE_PREFIX: &str = "iv-";
const INVITE_BODY_LEN: usize = 32;
const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn invalid_invite() -> ApiError {
    ApiError::InviteInvalid
}

/// Herald account ids are UUIDs; path/body targets that cannot be one are a 400 before any
/// upstream call (a nonexistent-but-well-formed id still reaches Herald and answers 404).
fn require_uuid_shape(value: &str) -> Result<(), ApiError> {
    let bytes = value.as_bytes();
    let shape = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 8 | 13 | 18 | 23) || b.is_ascii_hexdigit());
    if shape {
        Ok(())
    } else {
        Err(ApiError::InvalidInput {
            message: "userId must be a UUID".to_string(),
        })
    }
}

/// 32 base62 characters from rejection-sampled CSPRNG bytes (values ≥ 248 = 62·4 are dropped,
/// so the alphabet mapping stays unbiased). The full wire form "{spaceId}#iv-{body}" is what
/// gets hashed — the space prefix inside the hash pins a code to its space.
fn generate_invite_body() -> Result<String, ApiError> {
    let mut body = String::with_capacity(INVITE_BODY_LEN);
    while body.len() < INVITE_BODY_LEN {
        let mut buf = [0u8; 48];
        getrandom::fill(&mut buf).map_err(|_| ApiError::AuthUnavailable {
            message: "Failed to generate an invite code, please try again".to_string(),
        })?;
        for byte in buf {
            if (byte as usize) < 248 {
                body.push(BASE62[(byte % 62) as usize] as char);
                if body.len() == INVITE_BODY_LEN {
                    break;
                }
            }
        }
    }
    Ok(body)
}

/// Local shape check so malformed codes never touch the database (the extension applies the
/// same rule before sending). One stable answer — never a probe for which part failed.
pub(crate) fn parse_invite_code(raw: &str) -> Result<(String, String), ApiError> {
    let invalid = invalid_invite;
    let (space_id, secret) = raw.split_once('#').ok_or_else(invalid)?;
    if !is_valid_entity_id(space_id) {
        return Err(invalid());
    }
    let body = secret.strip_prefix(INVITE_PREFIX).ok_or_else(invalid)?;
    if body.len() != INVITE_BODY_LEN || !body.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(invalid());
    }
    Ok((space_id.to_string(), body.to_string()))
}

/// The caller's resolved entry into an org-bound space: the organization id plus the caller's
/// own tier facts as fetched by the access layer (no second upstream round trip).
struct OrgEntry {
    org_id: String,
    role: &'static str,
    is_owner: bool,
}

/// The member/invite surface's entry gate, one step for every handler: the org channel
/// client, space access and the org-bound invariant — this surface exists only for
/// org-bound spaces, and reaching it with a key-addressed id is a caller programming error
/// answered 400 (the extension never offers these actions there). The category is decided
/// before any key discipline: a key-addressed id gets that 400 whether or not an X-Space-Key
/// was presented — the header is not part of this surface's contract.
async fn require_org_space<'a>(
    state: &'a AppState,
    identity: &ResolvedIdentity,
    space_id: &str,
    need: SpaceAccess,
) -> Result<(&'a OrgClient, OrgEntry), ApiError> {
    let org = org_client_of(state)?;
    let Some(org_id) = space_org_binding(&state.pool, space_id).await? else {
        return Err(ApiError::InvalidInput {
            message: "This space is key-addressed; workspace permissions do not apply".to_string(),
        });
    };
    let (role, is_owner) = org_space_access(org, identity, &org_id, need).await?;
    Ok((
        org,
        OrgEntry {
            org_id,
            role,
            is_owner,
        },
    ))
}

fn org_client_of(state: &AppState) -> Result<&OrgClient, ApiError> {
    state.org.as_ref().ok_or_else(auth_unavailable)
}

/// The member shape returned by role-change and transfer calls (display fields are only
/// populated by the list proxy — one round trip, no per-user lookups).
fn member_dto(view: &crate::orgs::OrgMemberView) -> Result<MemberDto, ApiError> {
    let role = tier_to_role(&view.role_name).ok_or_else(auth_unavailable)?;
    Ok(MemberDto {
        user_id: view.user_id.clone(),
        email: None,
        nickname: None,
        role: role.to_string(),
        is_owner: view.is_owner,
        joined_at: None,
    })
}

/// Issue a one-time invite code.
///
/// Admin-tier capability. The plaintext code appears exactly once, in this response — there
/// is no listing or recovery endpoint (a lost unshared code means issuing another).
#[utoipa::path(
    post,
    path = "/api/spaces/{spaceId}/invites",
    tag = "workspace",
    request_body = (),
    params(("spaceId" = String, Path, description = "Space id")),
    security(("bearer_auth" = [])),
    responses(
        (status = 201, body = InviteDto, description = "Invite issued; the code is shown exactly this once and is valid for 24 h / a single redemption"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: key-addressed space"),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED"),
        (status = 403, body = ErrorBodyDto, description = "SPACE_ACCESS_DENIED (not a member) / SPACE_ROLE_REQUIRED (read-only member)"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE (membership server unreachable — fail-closed)"),
    )
)]
pub async fn issue_space_invite(
    identity: Option<Extension<ResolvedIdentity>>,
    State(state): State<AppState>,
    Path(space_id): Path<String>,
) -> Result<(StatusCode, Json<InviteDto>), ApiError> {
    let Some(identity) = identity.as_deref() else {
        return Err(ApiError::AuthRequired);
    };
    let (_, entry) = require_org_space(&state, identity, &space_id, SpaceAccess::Manage).await?;

    let body = generate_invite_body()?;
    let code = format!("{space_id}#{INVITE_PREFIX}{body}");
    let created_at = now_utc();
    let expires_at = format_utc(chrono::Utc::now() + chrono::Duration::hours(24));
    let mut tx = write_transaction(&state.pool).await?;
    // The write paths' shared discipline: a space deleted between the outer check and this
    // insert routes to 404 (space_invites references spaces; the FK cascade would otherwise
    // surface as a 500).
    require_space_row(&mut *tx, &space_id, None, Some(&entry.org_id)).await?;
    sqlx::query(
        "INSERT INTO space_invites (code_hash, space_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(sha256_hex(code.as_bytes()))
    .bind(&space_id)
    .bind(&created_at)
    .bind(&expires_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    tracing::info!(action = "issue_invite", space = %space_id, "workspace invite issued");
    Ok((
        StatusCode::CREATED,
        Json(InviteDto {
            space_id,
            code,
            created_at,
            expires_at,
        }),
    ))
}

/// Redeem an invite code: join the space as a read-only member.
///
/// The invite row's lock serializes same-code redemptions (exactly one succeeds); an
/// already-member caller converges on the idempotent 200 without consuming the code, and any
/// Herald failure rolls back with the code unconsumed (a dependency outage never burns a
/// code — retry is always safe).
#[utoipa::path(
    post,
    path = "/api/invites/redeem",
    tag = "workspace",
    request_body = RedeemInviteReq,
    security(("bearer_auth" = [])),
    responses(
        (status = 200, body = SpaceDto, description = "Joined (or already a member — idempotent); response carries myRole + myUserId"),
        (status = 400, body = ErrorBodyDto, description = "INVITE_INVALID: malformed / unknown code / key-addressed space"),
        (status = 400, body = ErrorBodyDto, description = "INVITE_EXPIRED: past the 24 h validity"),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED (the code is not consumed)"),
        (status = 409, body = ErrorBodyDto, description = "INVITE_ALREADY_USED: consumed by someone else while the caller is not a member"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE (membership server unreachable — the code is not consumed)"),
    )
)]
pub async fn redeem_invite(
    State(state): State<AppState>,
    identity: Option<Extension<ResolvedIdentity>>,
    ApiJson(req): ApiJson<RedeemInviteReq>,
) -> Result<Json<SpaceDto>, ApiError> {
    let Some(identity) = identity.as_deref() else {
        return Err(ApiError::AuthRequired);
    };
    let org = org_client_of(&state)?;
    let (prefix_space_id, _body) = parse_invite_code(&req.code)?;
    let code_hash = sha256_hex(req.code.as_bytes());

    let mut tx = write_transaction(&state.pool).await?;
    // Lock the invite row: same-code requests serialize here, so exactly one redemption can
    // consume it. `FOR UPDATE OF i` leaves the joined spaces row unlocked.
    let row = sqlx::query_as::<
        _,
        (
            String,
            Option<String>,
            String,
            String,
            String,
            Option<String>,
        ),
    >(
        "SELECT i.space_id, i.used_at, i.expires_at, s.name, s.created_at, s.org_id \
         FROM space_invites i JOIN spaces s ON s.id = i.space_id \
         WHERE i.code_hash = $1 FOR UPDATE OF i",
    )
    .bind(&code_hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let Some((row_space_id, used_at, expires_at, name, created_at, org_id)) = row else {
        return Err(invalid_invite());
    };
    if row_space_id != prefix_space_id {
        return Err(invalid_invite());
    }
    let Some(org_id) = org_id else {
        // Key-addressed spaces never issue codes; a hash hit against one is impossible by
        // construction — defensive single answer.
        return Err(invalid_invite());
    };
    let space_dto = |role: &str| {
        Json(SpaceDto {
            id: row_space_id.clone(),
            name: name.clone(),
            created_at: created_at.clone(),
            my_role: Some(role.to_string()),
            my_user_id: Some(identity.user_id.clone()),
        })
    };
    let member_role = |view: &crate::orgs::OrgMemberView| -> Result<&'static str, ApiError> {
        tier_to_role(&view.role_name).ok_or_else(auth_unavailable)
    };

    if used_at.is_some() {
        // Consumed: a member converges on the idempotent 200 (the "check, then retry" answer
        // for a caller whose response was lost); anyone else is told the code is spent.
        return match org.get_member(&org_id, &identity.user_id).await {
            Ok(Some(view)) => {
                let role = member_role(&view)?;
                tx.commit().await.map_err(ApiError::internal)?;
                Ok(space_dto(role))
            }
            Ok(None) => Err(ApiError::InviteAlreadyUsed),
            Err(err) => Err(map_org_error(err)),
        };
    }
    // Fixed-width RFC 3339 text: lexicographic comparison is chronological comparison.
    if expires_at.as_str() <= now_utc().as_str() {
        return Err(ApiError::InviteExpired);
    }
    match org.get_member(&org_id, &identity.user_id).await {
        Ok(Some(view)) => {
            // Already a member: join again changes nothing — the code stays valid (and a
            // higher tier is never demoted to the invite's member tier).
            let role = member_role(&view)?;
            tx.commit().await.map_err(ApiError::internal)?;
            Ok(space_dto(role))
        }
        Ok(None) => {
            // The code itself is the authorization — no actor (the actor management gate
            // would reject the not-yet-member joiner); the application acts on its own
            // authority and grants the fixed read-only tier.
            org.add_member(&org_id, &identity.user_id, TIER_MEMBER, None)
                .await
                .map_err(map_org_error)?;
            let burned = async {
                sqlx::query("UPDATE space_invites SET used_at = $1 WHERE code_hash = $2")
                    .bind(now_utc())
                    .bind(&code_hash)
                    .execute(&mut *tx)
                    .await
                    .map_err(ApiError::internal)?;
                tx.commit().await.map_err(ApiError::internal)
            }
            .await;
            if let Err(err) = burned {
                // The Herald membership granted above cannot roll back with the local
                // transaction. Undo it best-effort so a local failure keeps both halves of
                // the contract (the code is not burned, no member is left behind); if the
                // undo itself fails, that residue is an operations problem, logged without
                // any member identity.
                if org
                    .remove_member(&org_id, &identity.user_id, None)
                    .await
                    .is_err()
                {
                    tracing::warn!(
                        action = "redeem_invite_rollback",
                        space = %row_space_id,
                        "local commit failed and the compensating member removal failed — the code is still redeemable"
                    );
                }
                return Err(err);
            }
            tracing::info!(action = "redeem_invite", space = %row_space_id, "workspace invite redeemed");
            Ok(space_dto("member"))
        }
        Err(err) => Err(map_org_error(err)),
    }
}

/// Pagination mirrors the upstream member list: 1-based page (default 1), pageSize 1–100
/// (default 20); anything else is a 400 before the proxy call.
fn parse_member_page(query: &HashMap<String, String>) -> Result<(u64, u64), ApiError> {
    let mut page = 1u64;
    let mut page_size = 20u64;
    for (name, value) in query {
        let parsed = value.parse::<u64>().map_err(|_| ApiError::InvalidInput {
            message: format!("{name} must be a positive integer"),
        })?;
        match name.as_str() {
            "page" if parsed >= 1 => page = parsed,
            "pageSize" if (1..=100).contains(&parsed) => page_size = parsed,
            _ => {
                return Err(ApiError::InvalidInput {
                    message: format!("{name} is outside the allowed range"),
                })
            }
        }
    }
    if page
        .checked_sub(1)
        .and_then(|offset| offset.checked_mul(page_size))
        .is_none()
    {
        return Err(ApiError::InvalidInput {
            message: "page is outside the allowed range".to_string(),
        });
    }
    Ok((page, page_size))
}

/// List the space's members (live proxy).
///
/// Admin-tier capability. The list is fetched from Herald per call — never stored, never
/// logged; only the member ids needed to address role changes surface here.
#[utoipa::path(
    get,
    path = "/api/spaces/{spaceId}/members",
    tag = "workspace",
    params(
        ("spaceId" = String, Path, description = "Space id"),
        ("page" = Option<u64>, Query, description = "Page number (1-based, default 1)"),
        ("pageSize" = Option<u64>, Query, description = "Page size (1-100, default 20)"),
    ),
    security(("bearer_auth" = [])),
    responses(
        (status = 200, body = MemberListDto, description = "Members with role and owner marker, fetched live from the identity provider"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: key-addressed space or pagination"),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED"),
        (status = 403, body = ErrorBodyDto, description = "SPACE_ACCESS_DENIED / SPACE_ROLE_REQUIRED (read-only member)"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE (membership server unreachable — fail-closed)"),
    )
)]
pub async fn list_space_members(
    identity: Option<Extension<ResolvedIdentity>>,
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<MemberListDto>, ApiError> {
    let Some(identity) = identity.as_deref() else {
        return Err(ApiError::AuthRequired);
    };
    let (page, page_size) = parse_member_page(&query)?;
    let (org, entry) = require_org_space(&state, identity, &space_id, SpaceAccess::Manage).await?;

    let page_result = org
        .list_members(&entry.org_id, page, page_size)
        .await
        .map_err(map_org_error)?;
    let items = page_result
        .items
        .iter()
        .map(|item| {
            let role = tier_to_role(&item.role_name).ok_or_else(auth_unavailable)?;
            Ok(MemberDto {
                user_id: item.user_id.clone(),
                email: item.email.clone(),
                nickname: item.nickname.clone(),
                role: role.to_string(),
                is_owner: item.is_owner,
                joined_at: Some(item.joined_at.clone()),
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(MemberListDto {
        items,
        page,
        page_size,
        total: page_result.total,
    }))
}

/// Promote or demote a member between the admin and read-only tiers.
///
/// Admin-tier capability. The target must already be a member (upserting a stranger would
/// add them — the invite code is the only sanctioned join path); the owner tier is reachable
/// only through the transfer endpoint.
#[utoipa::path(
    patch,
    path = "/api/spaces/{spaceId}/members/{userId}",
    tag = "workspace",
    request_body = UpdateMemberRoleReq,
    params(
        ("spaceId" = String, Path, description = "Space id"),
        ("userId" = String, Path, description = "Member account id (UUID)"),
    ),
    security(("bearer_auth" = [])),
    responses(
        (status = 200, body = MemberDto, description = "Membership tier updated (same-tier replay is idempotent)"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: key-addressed space, non-UUID target, or role other than admin/member"),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED"),
        (status = 403, body = ErrorBodyDto, description = "SPACE_ACCESS_DENIED / SPACE_ROLE_REQUIRED (read-only member)"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND / MEMBER_NOT_FOUND"),
        (status = 409, body = ErrorBodyDto, description = "SPACE_OWNER_PROTECTED / SPACE_LAST_ADMIN_PROTECTED"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE (membership server unreachable — fail-closed)"),
    )
)]
pub async fn update_space_member_role(
    identity: Option<Extension<ResolvedIdentity>>,
    State(state): State<AppState>,
    Path((space_id, user_id)): Path<(String, String)>,
    ApiJson(req): ApiJson<UpdateMemberRoleReq>,
) -> Result<Json<MemberDto>, ApiError> {
    let Some(identity) = identity.as_deref() else {
        return Err(ApiError::AuthRequired);
    };
    if !matches!(req.role.as_str(), "admin" | "member") {
        return Err(ApiError::InvalidInput {
            message: "role must be 'admin' or 'member' (ownership moves via the transfer endpoint)"
                .to_string(),
        });
    }
    require_uuid_shape(&user_id)?;
    let (org, entry) = require_org_space(&state, identity, &space_id, SpaceAccess::Manage).await?;

    if org
        .get_member(&entry.org_id, &user_id)
        .await
        .map_err(map_org_error)?
        .is_none()
    {
        return Err(ApiError::MemberNotFound);
    }
    // actorUserId attributes the change to the real user in Herald's audit log and enables
    // its native management / self-hold gates as the defensive layer behind our pre-checks.
    let tier = role_to_tier(&req.role)
        .ok_or_else(|| ApiError::internal(anyhow::anyhow!("validated role without a tier")))?;
    let view = org
        .add_member(&entry.org_id, &user_id, tier, Some(&identity.user_id))
        .await
        .map_err(map_org_error)?;
    tracing::info!(action = "role_change", space = %space_id, "member role updated");
    Ok(Json(member_dto(&view)?))
}

/// Remove a member, or leave as oneself.
///
/// Removing someone else is an admin-tier capability; `target = self` is open to any member.
/// Owner and last-admin-tier protections (including self-exit) are enforced by Herald and
/// surface as 409s.
#[utoipa::path(
    delete,
    path = "/api/spaces/{spaceId}/members/{userId}",
    tag = "workspace",
    params(
        ("spaceId" = String, Path, description = "Space id"),
        ("userId" = String, Path, description = "Member account id (UUID); self-addressing leaves the space"),
    ),
    security(("bearer_auth" = [])),
    responses(
        (status = 204, description = "Member removed / self left"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: key-addressed space or non-UUID target"),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED"),
        (status = 403, body = ErrorBodyDto, description = "SPACE_ACCESS_DENIED / SPACE_ROLE_REQUIRED (removing someone else as a read-only member)"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND / MEMBER_NOT_FOUND"),
        (status = 409, body = ErrorBodyDto, description = "SPACE_OWNER_PROTECTED (owner, incl. self-exit) / SPACE_LAST_ADMIN_PROTECTED"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE (membership server unreachable — fail-closed)"),
    )
)]
pub async fn remove_space_member(
    identity: Option<Extension<ResolvedIdentity>>,
    State(state): State<AppState>,
    Path((space_id, user_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let Some(identity) = identity.as_deref() else {
        return Err(ApiError::AuthRequired);
    };
    require_uuid_shape(&user_id)?;
    let self_removal = user_id == identity.user_id;
    let need = if self_removal {
        SpaceAccess::Read
    } else {
        SpaceAccess::Manage
    };
    let (org, entry) = require_org_space(&state, identity, &space_id, need).await?;

    if !self_removal {
        // Removing someone else: the target must already be a member (a missing target is a
        // 404, not a silent success). The self-removal caller's own facts already came back
        // with `entry` — no second upstream lookup.
        if org
            .get_member(&entry.org_id, &user_id)
            .await
            .map_err(map_org_error)?
            .is_none()
        {
            return Err(ApiError::MemberNotFound);
        }
    }
    // Actor policy: admin/owner-initiated removals carry actorUserId for audit attribution
    // and Herald's gates. A read-only member's self-exit must not: the actor management gate
    // would reject a non-manager, and a plain member's removal has no protection need (a
    // read-only member is never the owner or the last admin-tier member).
    let actor = if self_removal && entry.role == "member" {
        None
    } else {
        Some(identity.user_id.as_str())
    };
    org.remove_member(&entry.org_id, &user_id, actor)
        .await
        .map_err(map_org_error)?;
    tracing::info!(action = "remove_member", space = %space_id, self_removal, "member removed");
    Ok(StatusCode::NO_CONTENT)
}

/// Transfer ownership in one atomic step.
///
/// Owner-only. Herald performs the whole move under its organization row lock — the target
/// gains the owner tier and the previous owner lands on admin simultaneously; there is no
/// intermediate state and no local transfer state machine.
#[utoipa::path(
    post,
    path = "/api/spaces/{spaceId}/ownership",
    tag = "workspace",
    request_body = TransferOwnershipReq,
    params(("spaceId" = String, Path, description = "Space id")),
    security(("bearer_auth" = [])),
    responses(
        (status = 200, body = MemberDto, description = "Ownership transferred; the new owner is returned (the previous owner is now an admin)"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: key-addressed space or non-UUID target"),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED"),
        (status = 403, body = ErrorBodyDto, description = "SPACE_ROLE_REQUIRED (only the owner can transfer) / SPACE_ACCESS_DENIED"),
        (status = 404, body = ErrorBodyDto, description = "SPACE_NOT_FOUND / MEMBER_NOT_FOUND"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE (membership server unreachable — fail-closed)"),
    )
)]
pub async fn transfer_space_ownership(
    identity: Option<Extension<ResolvedIdentity>>,
    State(state): State<AppState>,
    Path(space_id): Path<String>,
    ApiJson(req): ApiJson<TransferOwnershipReq>,
) -> Result<Json<MemberDto>, ApiError> {
    let Some(identity) = identity.as_deref() else {
        return Err(ApiError::AuthRequired);
    };
    require_uuid_shape(&req.user_id)?;
    let (org, entry) = require_org_space(&state, identity, &space_id, SpaceAccess::Manage).await?;
    // The owner gate: `entry` carries the caller's is_owner from the access layer's membership
    // lookup — the caller is a member by construction (require_org_space denies otherwise).
    if !entry.is_owner {
        return Err(ApiError::SpaceRoleRequired {
            message: "Only the space owner can transfer ownership".to_string(),
        });
    }
    if org
        .get_member(&entry.org_id, &req.user_id)
        .await
        .map_err(map_org_error)?
        .is_none()
    {
        return Err(ApiError::MemberNotFound);
    }
    let view = org
        .add_member(
            &entry.org_id,
            &req.user_id,
            TIER_OWNER,
            Some(&identity.user_id),
        )
        .await
        .map_err(map_org_error)?;
    tracing::info!(action = "transfer_ownership", space = %space_id, "ownership transferred");
    Ok(Json(member_dto(&view)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_codes_carry_the_space_prefixed_wire_shape() {
        let (space_id, body) =
            parse_invite_code("sp-AbCdEf0123456789#iv-0123456789abcdefghijklmnopqrstuv")
                .expect("well-formed code parses");
        assert_eq!(space_id, "sp-AbCdEf0123456789");
        assert_eq!(body, "0123456789abcdefghijklmnopqrstuv");
        assert_eq!(body.len(), INVITE_BODY_LEN);
        // Everything malformed gets the one stable answer: no probing which part failed.
        for bad in [
            "",
            "no-separator-at-all",
            "sp/short#iv-0123456789abcdefghijklmnopqrstuv",
            "sp-AbCdEf0123456789#0123456789abcdefghijklmnopqrstuv", // missing iv-
            "sp-AbCdEf0123456789#iv-0123456789abcdefghijklmnopqrstu", // 31 chars
            "sp-AbCdEf0123456789#iv-0123456789abcdefghijklmnopqrstuvw", // 33 chars
            "sp-AbCdEf0123456789#iv-0123456789abcdefghijklmnopqrstuv-", // '-' not base62
            "sp-AbCdEf0123456789#iv-0123456789abcdefghijklmnopq#stuvX", // second '#'
        ] {
            assert!(
                matches!(parse_invite_code(bad), Err(ApiError::InviteInvalid)),
                "{bad:?} must be INVITE_INVALID"
            );
        }
    }

    #[test]
    fn generated_invite_bodies_are_32_uniform_base62_chars() {
        for _ in 0..16 {
            let body = generate_invite_body().expect("CSPRNG generation");
            assert_eq!(body.len(), INVITE_BODY_LEN);
            assert!(body.bytes().all(|b| b.is_ascii_alphanumeric()));
            // Round-trips through the parser with a well-formed space id.
            let code = format!("sp-AbCdEf0123456789#{INVITE_PREFIX}{body}");
            let (space, parsed_body) = parse_invite_code(&code).expect("generated code parses");
            assert_eq!(space, "sp-AbCdEf0123456789");
            assert_eq!(parsed_body, body);
        }
    }

    #[test]
    fn uuid_shape_guard() {
        assert!(require_uuid_shape("0f0a6c6e-5f2f-4c9e-9a2b-3d4e5f6a7b8c").is_ok());
        assert!(require_uuid_shape("0F0A6C6E-5F2F-4C9E-9A2B-3D4E5F6A7B8C").is_ok());
        for bad in [
            "",
            "not-a-uuid",
            "0f0a6c6e5f2f4c9e9a2b3d4e5f6a7b8c",
            "0f0a6c6e-5f2f-4c9e-9a2b3d4e5f6a7b8c",
            "0f0a6c6e_5f2f-4c9e-9a2b-3d4e5f6a7b8c",
            "0f0a6c6e-5f2f-4c9g-9a2b-3d4e5f6a7b8c",
        ] {
            assert!(
                matches!(require_uuid_shape(bad), Err(ApiError::InvalidInput { .. })),
                "{bad:?} must be INVALID_INPUT"
            );
        }
    }

    #[test]
    fn member_pagination_mirrors_the_upstream_bounds() {
        let query = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert_eq!(
            parse_member_page(&query(&[])).unwrap(),
            (1, 20),
            "defaults: page 1, pageSize 20"
        );
        assert_eq!(
            parse_member_page(&query(&[("page", "3"), ("pageSize", "100")])).unwrap(),
            (3, 100)
        );
        for bad in [
            vec![("page", "0")],
            vec![("page", "-1")],
            vec![("page", "x")],
            vec![("pageSize", "0")],
            vec![("pageSize", "101")],
            vec![("pageSize", "")],
            vec![("other", "1")],
        ] {
            let refs: Vec<(&str, &str)> = bad.iter().map(|(k, v)| (*k, *v)).collect();
            assert!(
                matches!(
                    parse_member_page(&query(&refs)),
                    Err(ApiError::InvalidInput { .. })
                ),
                "{refs:?} must be INVALID_INPUT"
            );
        }
        // page * pageSize must stay representable for the upstream OFFSET bind.
        assert!(matches!(
            parse_member_page(&query(&[
                ("page", "18446744073709551615"),
                ("pageSize", "100")
            ])),
            Err(ApiError::InvalidInput { .. })
        ));
    }
}
