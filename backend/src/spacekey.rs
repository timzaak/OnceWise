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
use crate::AppState;

pub const SPACE_KEY_HEADER: &str = "X-Space-Key";

/// Extracted raw key material from the request header (verification against the stored hash happens
/// per space id in `require_space` — FromRequestParts cannot see path parameters).
#[derive(Debug, Clone)]
pub struct SpaceKeyHeader(pub String);

impl FromRequestParts<AppState> for SpaceKeyHeader {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let value = parts
            .headers
            .get(SPACE_KEY_HEADER)
            .and_then(|v| v.to_str().ok())
            .ok_or(ApiError::BadSpaceKey)?;
        if !is_plausible_key(value) {
            return Err(ApiError::BadSpaceKey);
        }
        Ok(SpaceKeyHeader(value.to_string()))
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

/// Verify the key against the stored hash: unknown space → 404 SPACE_NOT_FOUND (no id probing),
/// wrong key → 401 BAD_SPACE_KEY. Accepts any sqlx executor (pool or transaction connection) so the
/// write paths can re-verify inside their transaction.
pub async fn require_space<'e, E>(db: E, space_id: &str, key: &str) -> Result<(), ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let stored = sqlx::query_scalar::<_, String>("SELECT key_hash FROM spaces WHERE id = $1")
        .bind(space_id)
        .fetch_optional(db)
        .await
        .map_err(ApiError::internal)?;
    match stored {
        None => Err(ApiError::NotFound {
            code: "SPACE_NOT_FOUND",
            message: "Space not found".to_string(),
        }),
        Some(stored_hash) => {
            if constant_time_eq(&stored_hash, &sha256_hex(key.as_bytes())) {
                Ok(())
            } else {
                Err(ApiError::BadSpaceKey)
            }
        }
    }
}

/// Constant-time string equality over fixed-length hex digests (an early length return leaks only
/// the length, and both operands are always 64-char hashes here).
fn constant_time_eq(a: &str, b: &str) -> bool {
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
    async fn require_space_distinguishes_not_found_from_bad_key() {
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

        assert!(require_space(&pool, "sp-test00000000001", &key)
            .await
            .is_ok());
        // Wrong key → 401 BAD_SPACE_KEY, not 404 (no oracle for existence under a wrong key)
        assert!(matches!(
            require_space(&pool, "sp-test00000000001", &"k".repeat(31)).await,
            Err(ApiError::BadSpaceKey)
        ));
        assert!(matches!(
            require_space(&pool, "sp-missing00000001", &key).await,
            Err(ApiError::NotFound {
                code: "SPACE_NOT_FOUND",
                ..
            })
        ));
    }
}
