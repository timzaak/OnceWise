// No-account access control: every space-scoped request carries the space access key in the
// X-Space-Key header; the server stores and compares only SHA-256 hashes. Discipline:
// - keys are high-entropy client-generated secrets, so a plain hash (no argon2) is the right cost
//   model; hash comparison itself runs in constant time;
// - space existence is re-checked inside write transactions on every write path, closing the
//   "check passes, then the space is concurrently deleted before commit" race (the FK cascade
//   would otherwise surface as a 500);
// - concurrency that SQLite got from BEGIN IMMEDIATE serialization comes from PostgreSQL row
//   locks (`SELECT … FOR UPDATE` on the allocation row, see routes/scripts.rs) plus UNIQUE
//   backstops mapped to 409s;
// - write paths share the `write_transaction` entry point.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::orgs::{map_org_error, tier_to_role, OrgClient};
use crate::AppState;

pub const SPACE_KEY_HEADER: &str = "X-Space-Key";

/// Extracted raw key material from the request header. Optional: org-bound spaces neither
/// require nor interpret the header, so a missing or malformed value must not fail extraction
/// — the key-addressed 401 discipline lives in `require_space_access`, where the space
/// category is known.
#[derive(Debug, Clone, Default)]
pub struct SpaceKeyHeader(pub Option<String>);

impl FromRequestParts<AppState> for SpaceKeyHeader {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let value = parts
            .headers
            .get(SPACE_KEY_HEADER)
            .and_then(|v| v.to_str().ok())
            .filter(|v| is_plausible_key(v));
        Ok(SpaceKeyHeader(value.map(str::to_string)))
    }
}

/// Keys are opaque high-entropy strings from the client generator (32 base62 chars today); anything
/// shorter than 16 chars or containing whitespace is rejected without touching the database.
pub fn is_plausible_key(key: &str) -> bool {
    (16..=256).contains(&key.len()) && !key.chars().any(char::is_whitespace)
}

/// Entity ids (spaces / scripts) are client-generated opaque strings from the same family of
/// generators (`sp-`/`sc-` + base62). The server accepts the generic shape, not the prefix.
pub fn is_valid_entity_id(id: &str) -> bool {
    (4..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The signed-in identity resolved by the login gate and injected into request extensions
/// (absent in none mode, where no gate is mounted). Lives only for the request's duration.
#[derive(Debug, Clone)]
pub struct ResolvedIdentity {
    pub user_id: String,
    pub realm_id: String,
}

/// What a handler needs from the space access layer: read access is any org-bound member
/// (or any key holder); manage additionally excludes the read-only member tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpaceAccess {
    Read,
    Manage,
}

/// How the addressed space is entered, plus (for org-bound spaces) the caller's own tier
/// facts — role for response shaping (myRole) and the owner marker for the transfer gate —
/// so callers need no second upstream round trip.
#[derive(Debug, Clone)]
pub enum SpaceCategory {
    Key,
    OrgBound {
        org_id: String,
        role: &'static str,
        is_owner: bool,
    },
}

impl SpaceCategory {
    /// The row's org binding as the outer access check saw it — the `expected_org` argument
    /// for the in-transaction `require_space_row` re-verification.
    pub fn org_binding(&self) -> Option<&str> {
        match self {
            SpaceCategory::Key => None,
            SpaceCategory::OrgBound { org_id, .. } => Some(org_id),
        }
    }
}

/// The stored row's addressing columns: (key_hash, org_id). Unknown id → 404 SPACE_NOT_FOUND
/// (no probing); the CHECK constraint guarantees at most one of the two, and a row with
/// neither means the constraint was bypassed.
async fn stored_addressing<'e, E>(
    db: E,
    space_id: &str,
) -> Result<(Option<String>, Option<String>), ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let row = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT key_hash, org_id FROM spaces WHERE id = $1",
    )
    .bind(space_id)
    .fetch_optional(db)
    .await
    .map_err(ApiError::internal)?;
    let Some((key_hash, org_id)) = row else {
        return Err(space_not_found());
    };
    if key_hash.is_none() && org_id.is_none() {
        return Err(ApiError::internal(anyhow::anyhow!(
            "space row without an addressing method"
        )));
    }
    Ok((key_hash, org_id))
}

/// The local half of space access: the stored row's addressing method with the key-space
/// discipline enforced (missing-or-wrong key → 401 BAD_SPACE_KEY, constant-time compare).
/// `Ok(None)` is a key space, `Ok(Some(org_id))` an org-bound one. Shared by
/// `require_space_access` (which adds the Herald membership half) and by `require_space_row`
/// — the in-transaction re-verification, which must stay local.
async fn space_addressing<'e, E>(
    db: E,
    space_id: &str,
    key: Option<&str>,
) -> Result<Option<String>, ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let (key_hash, org_id) = stored_addressing(db, space_id).await?;
    match key_hash {
        Some(stored_hash) => match key {
            Some(key) if constant_time_eq(&stored_hash, &sha256_hex(key.as_bytes())) => Ok(None),
            _ => Err(ApiError::BadSpaceKey),
        },
        // stored_addressing rejects a row with neither addressing method, so no key_hash
        // implies an org_id.
        None => Ok(org_id),
    }
}

/// The row's addressing category without the key-space discipline — for surfaces that act on
/// the category itself: the member/invite endpoints answer a key-addressed id with their 400
/// whether or not a key was presented (the X-Space-Key header is not part of that surface's
/// contract). `Ok(None)` is a key space, `Ok(Some(org_id))` an org-bound one.
pub async fn space_org_binding<'e, E>(db: E, space_id: &str) -> Result<Option<String>, ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let (key_hash, org_id) = stored_addressing(db, space_id).await?;
    if key_hash.is_some() {
        return Ok(None);
    }
    Ok(org_id)
}

/// Local-only re-verification for inside a write transaction: the space row still exists and
/// is still addressed exactly as the outer `require_space_access` call saw it — a
/// key-addressed row still answers to the presented key, an org-bound row is still bound to
/// `expected_org`. A same-id delete-and-recreate interleave under the other addressing
/// method (or a different organization) therefore fails here instead of acting on the new
/// row; an org-authorized request never answers the key discipline — its row is either
/// still the same organization's or the space is gone. The Herald membership half of
/// `require_space_access` is deliberately not repeated here — an upstream GET cannot
/// serialize with the transaction, so a second in-transaction round trip would double the
/// upstream load and stretch the transaction's hold time without changing which facts decide
/// (membership changes take effect on the next request either way).
pub async fn require_space_row<'e, E>(
    db: E,
    space_id: &str,
    key: Option<&str>,
    expected_org: Option<&str>,
) -> Result<(), ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    match space_addressing(db, space_id, key).await {
        // Still the addressing the outer check authorized: a key row answering the
        // presented key, or the same organization's row.
        Ok(None) if expected_org.is_none() => Ok(()),
        Ok(Some(org_id)) if Some(org_id.as_str()) == expected_org => Ok(()),
        // The row a same-id recreate left behind answers to neither: the space this request
        // entered no longer exists, and the new row is not this caller's to touch.
        Ok(_) => Err(space_not_found()),
        Err(ApiError::BadSpaceKey) if expected_org.is_some() => Err(space_not_found()),
        // A key-authorized request whose key no longer answers keeps the plain 401; a
        // missing row keeps the 404 space_addressing already returned.
        err => err.map(|_| ()),
    }
}

fn space_not_found() -> ApiError {
    ApiError::NotFound {
        code: "SPACE_NOT_FOUND",
        message: "Space not found".to_string(),
    }
}

/// Category-aware space access, the second orthogonal layer after the login gate: key spaces
/// keep the exact key-hash discipline (unknown id → 404 SPACE_NOT_FOUND with no probing,
/// missing-or-wrong key → 401 BAD_SPACE_KEY, constant-time compare); org-bound spaces resolve
/// membership + tier from Herald on every call — nothing is cached, so a removal or demotion
/// is visible on the very next request. Write paths re-verify inside their transaction with
/// the local `require_space_row` instead of calling this again.
pub async fn require_space_access<'e, E>(
    db: E,
    org: Option<&OrgClient>,
    identity: Option<&ResolvedIdentity>,
    space_id: &str,
    key: Option<&str>,
    need: SpaceAccess,
) -> Result<SpaceCategory, ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let Some(org_id) = space_addressing(db, space_id, key).await? else {
        return Ok(SpaceCategory::Key);
    };
    let org = org.ok_or_else(|| {
        // A none-mode deployment cannot produce org-bound rows; meeting one is a
        // deployment inconsistency — fail closed with ops semantics, never a key prompt.
        ApiError::AuthUnavailable {
            message: "This space requires the sign-in mode (AUTH_MODE=herald)".to_string(),
        }
    })?;
    let identity = identity.ok_or_else(|| ApiError::AuthRequired)?;
    let (role, is_owner) = org_space_access(org, identity, &org_id, need).await?;
    Ok(SpaceCategory::OrgBound {
        org_id,
        role,
        is_owner,
    })
}

/// The Herald membership half of org-bound access, shared by `require_space_access` and by
/// the member/invite surface's category-first entry: membership + tier resolved live on
/// every call — nothing is cached, so a removal or demotion is visible on the very next
/// request; manage additionally excludes the read-only member tier. Returns the caller's
/// (role, is_owner) facts so callers need no second upstream round trip.
pub async fn org_space_access(
    org: &OrgClient,
    identity: &ResolvedIdentity,
    org_id: &str,
    need: SpaceAccess,
) -> Result<(&'static str, bool), ApiError> {
    let member = org
        .get_member(org_id, &identity.user_id)
        .await
        .map_err(map_org_error)?;
    let Some(view) = member else {
        return Err(ApiError::SpaceAccessDenied);
    };
    let Some(role) = tier_to_role(&view.role_name) else {
        // A tier outside the three built-ins is an out-of-contract answer: never
        // guessed into a permission grant.
        return Err(ApiError::AuthUnavailable {
            message: "The membership server answered with an unknown role tier".to_string(),
        });
    };
    if need == SpaceAccess::Manage && role == "member" {
        return Err(ApiError::SpaceRoleRequired {
            message: "Managing this space requires the admin role".to_string(),
        });
    }
    Ok((role, view.is_owner))
}

/// Constant-time string equality over fixed-length digests (an early length return leaks only
/// the length; callers pass fixed-size hex or base64url digests).
pub(crate) fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// The write-path transaction entry point: a plain PostgreSQL transaction; per-resource
/// serialization (version allocation, idempotency) is done with row locks / UNIQUE backstops
/// inside, not by locking the whole database.
pub async fn write_transaction(
    pool: &sqlx::PgPool,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, ApiError> {
    pool.begin().await.map_err(ApiError::internal)
}

/// Backstop validation for flowContent: must be a JSON object serialized to ≤ 262144 bytes.
/// Structural validation belongs to the extension's validateFlow (the cloud stores and distributes,
/// it never interprets fields). Returns the serialized text so callers insert without a second
/// serialization pass.
pub fn validate_flow_content(value: &serde_json::Value) -> Result<String, ApiError> {
    if !value.is_object() {
        return Err(ApiError::InvalidInput {
            message: "flowContent must be a JSON object".to_string(),
        });
    }
    let serialized = serde_json::to_string(value).map_err(ApiError::internal)?;
    if serialized.len() > 262_144 {
        return Err(ApiError::InvalidInput {
            message: "flowContent exceeds the 256 KiB limit once serialized".to_string(),
        });
    }
    Ok(serialized)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Version numbers are the one server-allocated value: canonical positive decimals only (no leading
/// zeros / signs), keeping one resource one URI.
pub fn parse_version_param(value: &str, name: &str) -> Result<i64, ApiError> {
    let invalid = || ApiError::InvalidInput {
        message: format!("{name} must be a positive integer"),
    };
    let canonical = value.starts_with(|c: char| c.is_ascii_digit() && c != '0')
        && value.chars().all(|c| c.is_ascii_digit());
    if !canonical {
        return Err(invalid());
    }
    value.parse::<i64>().map_err(|_| invalid())
}

pub fn validate_space_name(name: &str) -> Result<(), ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 50 {
        return Err(ApiError::InvalidInput {
            message: "Space name must be 1–50 characters".to_string(),
        });
    }
    Ok(())
}

pub fn validate_script_name(name: &str) -> Result<(), ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 100 {
        return Err(ApiError::InvalidInput {
            message: "Script name must be 1–100 characters".to_string(),
        });
    }
    Ok(())
}

pub fn validate_script_note(note: &str) -> Result<(), ApiError> {
    if note.chars().count() > 500 {
        return Err(ApiError::InvalidInput {
            message: "Script note must be at most 500 characters".to_string(),
        });
    }
    Ok(())
}

pub fn validate_version_note(note: &str) -> Result<(), ApiError> {
    if note.chars().count() > 200 {
        return Err(ApiError::InvalidInput {
            message: "Version note must be at most 200 characters".to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_param_accepts_only_canonical_form() {
        assert_eq!(parse_version_param("1", "versionNumber").unwrap(), 1);
        assert_eq!(
            parse_version_param("65535", "versionNumber").unwrap(),
            65535
        );
        // Everything outside canonical form is a 400: leading zeros / signs / empty / non-digits / overflow
        for raw in [
            "",
            "0",
            "007",
            "+9",
            "-3",
            "1a",
            " 1",
            "9223372036854775808",
        ] {
            assert!(
                matches!(
                    parse_version_param(raw, "versionNumber"),
                    Err(ApiError::InvalidInput { .. })
                ),
                "{raw:?} should be INVALID_INPUT"
            );
        }
    }

    #[test]
    fn entity_id_shape_and_key_plausibility() {
        assert!(is_valid_entity_id("sp-AbCdEf0123456789"));
        assert!(is_valid_entity_id("sc-xxxxxxxxxxxxxxxx"));
        assert!(!is_valid_entity_id("sp"));
        assert!(!is_valid_entity_id("sp/slash"));
        assert!(!is_valid_entity_id(&"x".repeat(65)));
        assert!(is_plausible_key(&"k".repeat(32)));
        assert!(!is_plausible_key("short"));
        assert!(!is_plausible_key("key with spaces is not a key at all"));
    }

    #[tokio::test]
    async fn require_space_access_distinguishes_not_found_from_bad_key() {
        let pool = crate::db::init_test_pool().await;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migration run failed");
        let key = "k".repeat(32);
        sqlx::query("INSERT INTO spaces (id, key_hash, name, created_at) VALUES ('sp-test00000000001', $1, 'Team', '2026-01-01T00:00:00.000Z')")
            .bind(sha256_hex(key.as_bytes()))
            .execute(&pool)
            .await
            .unwrap();

        assert!(matches!(
            require_space_access(
                &pool,
                None,
                None,
                "sp-test00000000001",
                Some(&key),
                SpaceAccess::Read
            )
            .await,
            Ok(SpaceCategory::Key)
        ));
        // Wrong key → 401 BAD_SPACE_KEY, not 404 (no oracle for existence under a wrong key);
        // a missing key on a key-addressed space is the same 401.
        for presented in [Some("k".repeat(31)), None] {
            assert!(
                matches!(
                    require_space_access(
                        &pool,
                        None,
                        None,
                        "sp-test00000000001",
                        presented.as_deref(),
                        SpaceAccess::Read
                    )
                    .await,
                    Err(ApiError::BadSpaceKey)
                ),
                "missing/wrong key must be BAD_SPACE_KEY"
            );
        }
        assert!(matches!(
            require_space_access(
                &pool,
                None,
                None,
                "sp-missing00000001",
                Some(&key),
                SpaceAccess::Read
            )
            .await,
            Err(ApiError::NotFound {
                code: "SPACE_NOT_FOUND",
                ..
            })
        ));
    }

    #[tokio::test]
    async fn require_space_row_rejects_a_recreated_row_under_another_addressing() {
        let pool = crate::db::init_test_pool().await;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migration run failed");
        let key = "k".repeat(32);
        sqlx::query("INSERT INTO spaces (id, key_hash, name, created_at) VALUES ('sp-test00000000003', $1, 'X', '2026-01-01T00:00:00.000Z')")
            .bind(sha256_hex(key.as_bytes()))
            .execute(&pool)
            .await
            .unwrap();

        // The row the outer check saw: a key row answering the presented key.
        assert!(
            require_space_row(&pool, "sp-test00000000003", Some(&key), None)
                .await
                .is_ok()
        );
        // A stale org-bound caller (authorized for some org) hitting that key-recreated row
        // must not pass — the space they entered no longer exists.
        assert!(matches!(
            require_space_row(
                &pool,
                "sp-test00000000003",
                None,
                Some("org-test0000000002")
            )
            .await,
            Err(ApiError::NotFound { .. })
        ));

        // Same id deleted and recreated org-bound: a stale key holder must not pass either,
        // while a caller of the new binding does.
        sqlx::query("UPDATE spaces SET key_hash = NULL, org_id = 'org-test0000000002' WHERE id = 'sp-test00000000003'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            require_space_row(&pool, "sp-test00000000003", Some(&key), None).await,
            Err(ApiError::NotFound { .. })
        ));
        assert!(require_space_row(
            &pool,
            "sp-test00000000003",
            None,
            Some("org-test0000000002")
        )
        .await
        .is_ok());
        // A different organization's binding is a different space.
        assert!(matches!(
            require_space_row(
                &pool,
                "sp-test00000000003",
                None,
                Some("org-test0000000009")
            )
            .await,
            Err(ApiError::NotFound { .. })
        ));
    }
}
