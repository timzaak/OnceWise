// Constraint: handlers never hand-write `(StatusCode, String)` / bare `StatusCode` / ad-hoc error JSON;
// the unified error body is `{"error":{"code":"<machine code>","message":"<readable>"}}` (a stable
// contract — the extension surfaces `message` verbatim as the failure detail).

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::dto::{ErrorBodyDto, ErrorDto};

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// 400 INVALID_INPUT
    #[error("{message}")]
    InvalidInput { message: String },
    /// 401 BAD_SPACE_KEY (missing header, wrong key or malformed key)
    #[error("The space key was rejected for this space")]
    BadSpaceKey,
    /// 401 AUTH_REQUIRED (herald mode: missing/empty/invalid Bearer or the identity provider
    /// rejected the token). Distinct from BAD_SPACE_KEY at the same status via `code`.
    #[error("Sign-in is required to access this server")]
    AuthRequired,
    /// 503 AUTH_UNAVAILABLE (herald mode: the identity provider is unreachable, times out or
    /// answered outside the expected contract — fail-closed, never a silent allow).
    #[error("{message}")]
    AuthUnavailable { message: String },
    /// 404 `<code>`: SPACE_NOT_FOUND / SCRIPT_NOT_FOUND / VERSION_NOT_FOUND / MEMBER_NOT_FOUND /
    /// NOT_FOUND (fallback route)
    #[error("{message}")]
    NotFound { code: &'static str, message: String },
    /// 409 `<code>`: SPACE_KEY_MISMATCH / SCRIPT_EXISTS
    #[error("{message}")]
    Conflict { code: &'static str, message: String },
    /// 403 SPACE_ACCESS_DENIED (org-bound space: caller is not a member — the same answer for a
    /// never-member and a removed one, so membership is never probed)
    #[error("You do not have access to this space")]
    SpaceAccessDenied,
    /// 403 SPACE_ROLE_REQUIRED (org-bound space: the action needs the admin tier or ownership;
    /// message varies by scene — read-only write attempt / member management / transfer)
    #[error("{message}")]
    SpaceRoleRequired { message: String },
    /// 409 SPACE_OWNER_PROTECTED (owner cannot be removed or demoted)
    #[error("The space owner cannot be removed or demoted; transfer ownership first")]
    SpaceOwnerProtected,
    /// 409 SPACE_LAST_ADMIN_PROTECTED (the last admin-tier member cannot leave the tier)
    #[error(
        "Keep at least one admin-tier member; grant another admin or transfer ownership first"
    )]
    SpaceLastAdminProtected,
    /// 404 MEMBER_NOT_FOUND (role-change / removal / transfer target is not a member)
    #[error("Member not found")]
    MemberNotFound,
    /// 400 INVITE_INVALID (malformed / unknown / wrong-space code — one stable answer)
    #[error("The invite code is invalid")]
    InviteInvalid,
    /// 400 INVITE_EXPIRED (past the 24 h validity — distinct from invalid)
    #[error("The invite code has expired")]
    InviteExpired,
    /// 409 INVITE_ALREADY_USED (consumed by someone else while the caller is not a member)
    #[error("The invite code has already been used")]
    InviteAlreadyUsed,
    /// 500 INTERNAL (never leaks the underlying error; the anyhow source is logged separately)
    #[error("Internal server error")]
    Internal(#[from] anyhow::Error),
}

impl ApiError {
    pub fn status(&self) -> StatusCode {
        match self {
            ApiError::InvalidInput { .. } => StatusCode::BAD_REQUEST,
            ApiError::BadSpaceKey => StatusCode::UNAUTHORIZED,
            ApiError::AuthRequired => StatusCode::UNAUTHORIZED,
            ApiError::AuthUnavailable { .. } => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::NotFound { .. } => StatusCode::NOT_FOUND,
            ApiError::Conflict { .. } => StatusCode::CONFLICT,
            ApiError::SpaceAccessDenied => StatusCode::FORBIDDEN,
            ApiError::SpaceRoleRequired { .. } => StatusCode::FORBIDDEN,
            ApiError::SpaceOwnerProtected => StatusCode::CONFLICT,
            ApiError::SpaceLastAdminProtected => StatusCode::CONFLICT,
            ApiError::MemberNotFound => StatusCode::NOT_FOUND,
            ApiError::InviteInvalid => StatusCode::BAD_REQUEST,
            ApiError::InviteExpired => StatusCode::BAD_REQUEST,
            ApiError::InviteAlreadyUsed => StatusCode::CONFLICT,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            ApiError::InvalidInput { .. } => "INVALID_INPUT",
            ApiError::BadSpaceKey => "BAD_SPACE_KEY",
            ApiError::AuthRequired => "AUTH_REQUIRED",
            ApiError::AuthUnavailable { .. } => "AUTH_UNAVAILABLE",
            ApiError::NotFound { code, .. } => code,
            ApiError::Conflict { code, .. } => code,
            ApiError::SpaceAccessDenied => "SPACE_ACCESS_DENIED",
            ApiError::SpaceRoleRequired { .. } => "SPACE_ROLE_REQUIRED",
            ApiError::SpaceOwnerProtected => "SPACE_OWNER_PROTECTED",
            ApiError::SpaceLastAdminProtected => "SPACE_LAST_ADMIN_PROTECTED",
            ApiError::MemberNotFound => "MEMBER_NOT_FOUND",
            ApiError::InviteInvalid => "INVITE_INVALID",
            ApiError::InviteExpired => "INVITE_EXPIRED",
            ApiError::InviteAlreadyUsed => "INVITE_ALREADY_USED",
            ApiError::Internal(_) => "INTERNAL",
        }
    }

    pub(crate) fn internal(err: impl Into<anyhow::Error>) -> Self {
        ApiError::Internal(err.into())
    }
}

/// Default 503 AUTH_UNAVAILABLE payload (identity dependency failure — fail-closed).
pub(crate) fn auth_unavailable() -> ApiError {
    ApiError::AuthUnavailable {
        message: "The sign-in service is unavailable, please try again later".to_string(),
    }
}

/// 404 NOT_FOUND "No such endpoint" — the router fallback and the auth endpoints' not-mounted
/// guard share one payload so the two paths can never drift apart.
pub(crate) fn endpoint_not_found() -> ApiError {
    ApiError::NotFound {
        code: "NOT_FOUND",
        message: "No such endpoint".to_string(),
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        // Shares the same struct with the OpenAPI document, so wire format and openapi.json are not
        // maintained in two places
        let body = Json(ErrorBodyDto {
            error: ErrorDto {
                code: self.code().to_string(),
                message: self.to_string(),
            },
        });
        (status, body).into_response()
    }
}

/// The single sqlx unique-constraint detector (script id / version-number backstop constraints).
pub(crate) fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .is_some_and(|db| db.is_unique_violation())
}

/// Request-body JSON extraction: parse failures (including size overflows) map uniformly to a 400
/// INVALID_INPUT error body instead of axum's default 415/422 plain text.
pub struct ApiJson<T>(pub T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: serde::de::DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state)
            .await
            .map_err(|_| ApiError::InvalidInput {
                message: "Request body is missing, not JSON, or over the size limit".to_string(),
            })?;
        let value = serde_json::from_slice(&bytes).map_err(|err| ApiError::InvalidInput {
            message: format!("Request body is not valid JSON: {err}"),
        })?;
        Ok(ApiJson(value))
    }
}
