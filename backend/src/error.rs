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
    /// 404 `<code>`: SPACE_NOT_FOUND / SCRIPT_NOT_FOUND / VERSION_NOT_FOUND / NOT_FOUND (fallback route)
    #[error("{message}")]
    NotFound { code: &'static str, message: String },
    /// 409 `<code>`: SPACE_KEY_MISMATCH / SCRIPT_EXISTS
    #[error("{message}")]
    Conflict { code: &'static str, message: String },
    /// 500 INTERNAL (never leaks the underlying error; the anyhow source is logged separately)
    #[error("Internal server error")]
    Internal(#[from] anyhow::Error),
}

impl ApiError {
    pub fn status(&self) -> StatusCode {
        match self {
            ApiError::InvalidInput { .. } => StatusCode::BAD_REQUEST,
            ApiError::BadSpaceKey => StatusCode::UNAUTHORIZED,
            ApiError::NotFound { .. } => StatusCode::NOT_FOUND,
            ApiError::Conflict { .. } => StatusCode::CONFLICT,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            ApiError::InvalidInput { .. } => "INVALID_INPUT",
            ApiError::BadSpaceKey => "BAD_SPACE_KEY",
            ApiError::NotFound { code, .. } => code,
            ApiError::Conflict { code, .. } => code,
            ApiError::Internal(_) => "INTERNAL",
        }
    }

    pub(crate) fn internal(err: impl Into<anyhow::Error>) -> Self {
        ApiError::Internal(err.into())
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
