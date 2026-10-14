// Field naming is camelCase (serde rename_all); `flowContent` is opaque JSON to the server.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDto {
    pub id: String,
    pub name: String,
    pub created_at: String,
    /// "owner" | "admin" | "member" — present only for org-bound spaces when the caller is a
    /// member; key-addressed spaces never emit it (old response bytes stay identical).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub my_role: Option<String>,
    /// The caller's own account id alongside myRole (self-exit addressing and the member
    /// view's "you" marker); never persisted or logged server-side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub my_user_id: Option<String>,
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

/// Register a space. With `key`: the key-addressed space (the server stores only the
/// SHA-256 hash). Without `key` (herald mode only): an organization-bound space whose
/// creator becomes the owner.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpaceReq {
    pub id: String,
    /// 16–256 chars without whitespace; omit to create an org-bound space (400 in none mode).
    pub key: Option<String>,
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

/// Sign-in mode probe (public in both run modes; `loginUrl` is only meaningful when enabled).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfigDto {
    pub enabled: bool,
    pub login_url: Option<String>,
    /// Whether org-bound spaces, invites and member management are served (herald mode with
    /// the organization channel configured; false on older servers and in none mode).
    pub workspace_permissions: bool,
}

/// A one-time invite code: the plaintext appears exactly once, in the issuing response.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InviteDto {
    pub space_id: String,
    /// Full wire form "{spaceId}#iv-{32 base62}" — pasteable into the same join field as a
    /// space code and locally distinguishable from one.
    pub code: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RedeemInviteReq {
    pub code: String,
}

/// One member of an org-bound space; display fields (email/nickname/joinedAt) appear only in
/// list responses — role-change and transfer answers carry the addressing facts only.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberDto {
    pub user_id: String,
    pub email: Option<String>,
    pub nickname: Option<String>,
    /// "owner" | "admin" | "member" (mapped from the provider's built-in tiers).
    pub role: String,
    pub is_owner: bool,
    pub joined_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberListDto {
    pub items: Vec<MemberDto>,
    pub page: u64,
    pub page_size: u64,
    pub total: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemberRoleReq {
    /// "admin" | "member" ("owner" is a 400 — ownership moves via the transfer endpoint).
    pub role: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferOwnershipReq {
    pub user_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RefreshTokenReq {
    pub refresh_token: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RedeemTokenReq {
    pub handoff_code: String,
    pub handoff_verifier: String,
}

/// Access/refresh token pair as delivered to the extension (POST bodies only — tokens never
/// appear in URLs). `expiresIn`/`refreshExpiresIn` are remaining seconds (rounded down).
#[derive(Serialize, Clone, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenSetDto {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub refresh_expires_in: i64,
    pub token_type: String,
}

// Manual Debug: the two token fields are secrets and must never reach a log line.
impl std::fmt::Debug for TokenSetDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenSetDto")
            .field("expires_in", &self.expires_in)
            .field("refresh_expires_in", &self.refresh_expires_in)
            .field("token_type", &self.token_type)
            .finish_non_exhaustive()
    }
}
