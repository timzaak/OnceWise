// Field naming is camelCase (serde rename_all); `flowContent` is opaque JSON to the server.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDto {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDto {
    pub id: String,
    pub name: String,
    pub note: String,
    pub latest_version_number: i64,
    pub latest_version_note: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VersionMetaDto {
    pub version_number: i64,
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VersionDto {
    #[serde(flatten)]
    pub meta: VersionMetaDto,
    pub flow_content: serde_json::Value,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthDto {
    pub status: String,
}

/// Unified error body `{"error":{"code","message"}}`; the code set is a stable contract.
#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorDto {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBodyDto {
    pub error: ErrorDto,
}

/// Register a locally generated space: the server stores only the SHA-256 hash of `key`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpaceReq {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateScriptReq {
    /// Client-generated script id (the server rejects duplicates with 409 SCRIPT_EXISTS)
    pub id: String,
    pub name: String,
    pub note: Option<String>,
    pub version_note: Option<String>,
    pub flow_content: serde_json::Value,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateScriptVersionReq {
    pub version_note: Option<String>,
    pub flow_content: serde_json::Value,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateScriptReq {
    pub name: Option<String>,
    pub note: Option<String>,
}
