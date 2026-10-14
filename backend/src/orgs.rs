// Server-to-server Herald organization channel: one reqwest client per deployment speaking
// to the ext org API under {base}/api/ext/realms/{realm}/orgs… with the X-API-Key bound to
// the BFF client app (HERALD_ORG_API_KEY). Discipline:
// - the organization layer is the sole authority for membership and tiers; transport
//   failures, timeouts, 5xx answers, 401/403 policy gates and contract violations all
//   collapse into `OrgApiError::Unavailable` and fail closed (503) at the caller — when the
//   authority cannot speak, nothing is allowed;
// - membership facts are never cached here: "removal/demotion takes effect on the next
//   request" is a product requirement, and Herald invalidates its own caches on change;
// - upstream error bodies are consumed for `status` + `code` only; message/details are
//   never forwarded to clients (no upstream information leaks).

use anyhow::Context as _;
use serde::Deserialize;
use std::time::Duration;

use crate::error::{auth_unavailable, ApiError};

pub const TIER_OWNER: &str = "org-owner";
pub const TIER_ADMIN: &str = "org-admin";
pub const TIER_MEMBER: &str = "org-member";

const ORG_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct OrgClient {
    http: reqwest::Client,
    base_url: String,
    realm_id: String,
    api_key: String,
}

#[derive(Debug)]
pub struct OrgCreated {
    pub id: String,
    pub owner_id: String,
}

#[derive(Debug)]
pub struct OrgMemberView {
    pub user_id: String,
    pub role_name: String,
    pub is_owner: bool,
}

#[derive(Debug)]
pub struct OrgMemberPageItem {
    pub user_id: String,
    pub email: Option<String>,
    pub nickname: Option<String>,
    pub role_name: String,
    pub is_owner: bool,
    pub joined_at: String,
}

#[derive(Debug)]
pub struct OrgMemberPage {
    pub items: Vec<OrgMemberPageItem>,
    pub page: u64,
    pub page_size: u64,
    pub total: i64,
}

#[derive(Debug)]
pub enum OrgApiError {
    Unavailable,
    /// A structured upstream 4xx answer (protections, missing member/target, validation);
    /// mapped per call context, never passed through verbatim.
    Upstream {
        status: u16,
        code: String,
    },
}

#[derive(Deserialize)]
struct ErrorWire {
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgCreatedWire {
    id: String,
    owner_id: String,
}

#[derive(Deserialize)]
struct OrgRoleRefWire {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetMemberWire {
    member: bool,
    user_id: String,
    role: Option<OrgRoleRefWire>,
    is_owner: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertMemberWire {
    user_id: String,
    role: OrgRoleRefWire,
    is_owner: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberListItemWire {
    user_id: String,
    email: Option<String>,
    nickname: Option<String>,
    role: OrgRoleRefWire,
    is_owner: bool,
    joined_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberPageWire {
    items: Vec<MemberListItemWire>,
    page: u64,
    page_size: u64,
    total: i64,
}

/// The three built-in tiers are the only tier names this server interprets; anything else is
/// an out-of-contract answer and fails closed at the caller, never guessed.
pub fn tier_to_role(name: &str) -> Option<&'static str> {
    match name {
        TIER_OWNER => Some("owner"),
        TIER_ADMIN => Some("admin"),
        TIER_MEMBER => Some("member"),
        _ => None,
    }
}

/// Wire role names ("owner" | "admin" | "member") → Herald tier names.
pub fn role_to_tier(role: &str) -> Option<&'static str> {
    match role {
        "owner" => Some(TIER_OWNER),
        "admin" => Some(TIER_ADMIN),
        "member" => Some(TIER_MEMBER),
        _ => None,
    }
}

/// The uniform Herald-answer → ApiError mapping for the org channel. Callers with
/// call-site-specific tolerances (organization deletion treats 404 as already-gone) handle
/// those before falling through to this.
pub(crate) fn map_org_error(err: OrgApiError) -> ApiError {
    match err {
        OrgApiError::Unavailable => auth_unavailable(),
        OrgApiError::Upstream { status, code } => match (status, code.as_str()) {
            (409, "org_owner_protected") => ApiError::SpaceOwnerProtected,
            (409, "org_last_admin_protected") => ApiError::SpaceLastAdminProtected,
            (404, "org_member_not_found") | (404, "user_not_found") => ApiError::MemberNotFound,
            (403, "org_actor_not_manager")
            | (403, "org_actor_self_hold_required")
            | (403, "org_ownership_transfer_denied") => ApiError::SpaceRoleRequired {
                message: "You do not have permission to change this space's members".to_string(),
            },
            (400, "org_account_scope_mismatch") => ApiError::InvalidInput {
                message: "The account does not belong to this deployment's realm".to_string(),
            },
            // Everything else — 401/403 policy gates, org_not_found on access paths (the
            // space row and the organization fact disagree: an operations problem, not a
            // client one), missing built-in tiers, upstream validation bodies — fails closed.
            _ => auth_unavailable(),
        },
    }
}

async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, OrgApiError> {
    request.send().await.map_err(|err| {
        tracing::debug!("herald org request failed: {err}");
        OrgApiError::Unavailable
    })
}

async fn error_of(response: reqwest::Response) -> OrgApiError {
    if response.status().as_u16() >= 500 {
        return OrgApiError::Unavailable;
    }
    let status = response.status().as_u16();
    match response.json::<ErrorWire>().await {
        Ok(wire) if !wire.code.is_empty() => OrgApiError::Upstream {
            status,
            code: wire.code,
        },
        _ => OrgApiError::Unavailable,
    }
}

async fn expect_success(response: reqwest::Response) -> Result<reqwest::Response, OrgApiError> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(error_of(response).await)
    }
}

impl OrgClient {
    pub fn new(base_url: &str, realm_id: &str, api_key: &str) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(ORG_TIMEOUT)
            // A POST to the org API must never be steered to another origin by a redirect.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("failed to build the Herald organization client")?;
        Ok(Self {
            http,
            base_url: base_url.to_string(),
            realm_id: realm_id.to_string(),
            api_key: api_key.to_string(),
        })
    }

    fn orgs_url(&self, suffix: &str) -> String {
        format!(
            "{}/api/ext/realms/{}/orgs{suffix}",
            self.base_url,
            urlencoding::encode(&self.realm_id)
        )
    }

    fn request(&self, method: reqwest::Method, url: String) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .header("X-API-Key", &self.api_key)
    }

    /// Register the organization for an app-side grouping. Idempotent per
    /// (realm, bound client app, externalId): a replay returns the existing organization with
    /// `created = false` and does not apply the new payload — the caller must verify the
    /// echoed ownerId is the intended one before binding.
    pub async fn create_org(
        &self,
        external_id: &str,
        name: &str,
        owner_user_id: &str,
    ) -> Result<OrgCreated, OrgApiError> {
        let request =
            self.request(reqwest::Method::POST, self.orgs_url(""))
                .json(&serde_json::json!({
                    "externalId": external_id,
                    "name": name,
                    "ownerId": owner_user_id,
                }));
        let response = expect_success(send(request).await?).await?;
        let wire: OrgCreatedWire = response
            .json()
            .await
            .map_err(|_| OrgApiError::Unavailable)?;
        if wire.id.is_empty() || wire.owner_id.is_empty() {
            return Err(OrgApiError::Unavailable);
        }
        Ok(OrgCreated {
            id: wire.id,
            owner_id: wire.owner_id,
        })
    }

    /// Delete the organization (memberships cascade inside Herald; repeat deletes answer
    /// 404 → Ok so retries converge).
    pub async fn delete_org(&self, org_id: &str) -> Result<(), OrgApiError> {
        let url = self.orgs_url(&format!("/{}", urlencoding::encode(org_id)));
        let response = send(self.request(reqwest::Method::DELETE, url)).await?;
        match response.status().as_u16() {
            204 | 404 => Ok(()),
            _ => Err(error_of(response).await),
        }
    }

    /// Factual membership read (no rule evaluation): `None` means not a member — the same
    /// answer for a never-member and a removed one, so existence is not probed.
    pub async fn get_member(
        &self,
        org_id: &str,
        user_id: &str,
    ) -> Result<Option<OrgMemberView>, OrgApiError> {
        let url = self.orgs_url(&format!(
            "/{}/members/{}",
            urlencoding::encode(org_id),
            urlencoding::encode(user_id)
        ));
        let response = expect_success(send(self.request(reqwest::Method::GET, url)).await?).await?;
        let wire: GetMemberWire = response
            .json()
            .await
            .map_err(|_| OrgApiError::Unavailable)?;
        if !wire.member {
            return Ok(None);
        }
        // member = true without the tier facts is an out-of-contract body.
        let (Some(role), Some(is_owner)) = (wire.role, wire.is_owner) else {
            return Err(OrgApiError::Unavailable);
        };
        Ok(Some(OrgMemberView {
            user_id: wire.user_id,
            role_name: role.name,
            is_owner,
        }))
    }

    /// Add or change a member's tier (idempotent upsert; granting org-owner is the atomic
    /// ownership transfer). `actor = None` is the application acting on its own authority
    /// (invite redemption); `Some(user)` attributes the change to that user and enables
    /// Herald's management / self-hold / transfer gates.
    pub async fn add_member(
        &self,
        org_id: &str,
        user_id: &str,
        tier: &str,
        actor: Option<&str>,
    ) -> Result<OrgMemberView, OrgApiError> {
        let url = self.orgs_url(&format!("/{}/members", urlencoding::encode(org_id)));
        let request = self
            .request(reqwest::Method::POST, url)
            .json(&serde_json::json!({
                "userId": user_id,
                "role": tier,
                "actorUserId": actor,
            }));
        let response = expect_success(send(request).await?).await?;
        let wire: UpsertMemberWire = response
            .json()
            .await
            .map_err(|_| OrgApiError::Unavailable)?;
        Ok(OrgMemberView {
            user_id: wire.user_id,
            role_name: wire.role.name,
            is_owner: wire.is_owner,
        })
    }

    /// Remove a member; takes effect on the next access (Herald invalidates its caches).
    pub async fn remove_member(
        &self,
        org_id: &str,
        user_id: &str,
        actor: Option<&str>,
    ) -> Result<(), OrgApiError> {
        let mut url = self.orgs_url(&format!(
            "/{}/members/{}",
            urlencoding::encode(org_id),
            urlencoding::encode(user_id)
        ));
        if let Some(actor) = actor {
            url.push_str(&format!("?actorUserId={}", urlencoding::encode(actor)));
        }
        expect_success(send(self.request(reqwest::Method::DELETE, url)).await?).await?;
        Ok(())
    }

    /// List members with account display fields (page 1-based, pageSize 1–100 — the caller
    /// validates pagination so the upstream mirror never diverges).
    pub async fn list_members(
        &self,
        org_id: &str,
        page: u64,
        page_size: u64,
    ) -> Result<OrgMemberPage, OrgApiError> {
        let url = self.orgs_url(&format!(
            "/{}/members?page={page}&pageSize={page_size}",
            urlencoding::encode(org_id)
        ));
        let response = expect_success(send(self.request(reqwest::Method::GET, url)).await?).await?;
        let wire: MemberPageWire = response
            .json()
            .await
            .map_err(|_| OrgApiError::Unavailable)?;
        Ok(OrgMemberPage {
            items: wire
                .items
                .into_iter()
                .map(|item| OrgMemberPageItem {
                    user_id: item.user_id,
                    email: item.email,
                    nickname: item.nickname,
                    role_name: item.role.name,
                    is_owner: item.is_owner,
                    joined_at: item.joined_at,
                })
                .collect(),
            page: wire.page,
            page_size: wire.page_size,
            total: wire.total,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_and_role_names_map_onto_each_other() {
        for tier_and_role in [
            (TIER_OWNER, "owner"),
            (TIER_ADMIN, "admin"),
            (TIER_MEMBER, "member"),
        ] {
            assert_eq!(tier_to_role(tier_and_role.0), Some(tier_and_role.1));
            assert_eq!(role_to_tier(tier_and_role.1), Some(tier_and_role.0));
        }
        // Non-builtin tier names and wire roles are never guessed into a permission grant.
        assert_eq!(tier_to_role("org-guest"), None);
        assert_eq!(tier_to_role(""), None);
        assert_eq!(role_to_tier("owner "), None);
    }

    #[test]
    fn upstream_errors_map_to_the_contract_codes() {
        let cases: [(OrgApiError, &str, u16); 6] = [
            (OrgApiError::Unavailable, "AUTH_UNAVAILABLE", 503),
            (
                OrgApiError::Upstream {
                    status: 409,
                    code: "org_owner_protected".to_string(),
                },
                "SPACE_OWNER_PROTECTED",
                409,
            ),
            (
                OrgApiError::Upstream {
                    status: 409,
                    code: "org_last_admin_protected".to_string(),
                },
                "SPACE_LAST_ADMIN_PROTECTED",
                409,
            ),
            (
                OrgApiError::Upstream {
                    status: 404,
                    code: "org_member_not_found".to_string(),
                },
                "MEMBER_NOT_FOUND",
                404,
            ),
            (
                OrgApiError::Upstream {
                    status: 404,
                    code: "user_not_found".to_string(),
                },
                "MEMBER_NOT_FOUND",
                404,
            ),
            // A deployment/policy 403 is an out-of-contract answer: fail closed, not a
            // client-facing permission denial.
            (
                OrgApiError::Upstream {
                    status: 403,
                    code: "org_client_app_key_required".to_string(),
                },
                "AUTH_UNAVAILABLE",
                503,
            ),
        ];
        for (err, code, status) in cases {
            let mapped = map_org_error(err);
            assert_eq!(mapped.code(), code);
            assert_eq!(mapped.status().as_u16(), status);
        }
        // The owner/last-admin protections keep their guidance messages.
        assert!(matches!(
            map_org_error(OrgApiError::Upstream {
                status: 409,
                code: "org_owner_protected".to_string()
            }),
            ApiError::SpaceOwnerProtected
        ));
    }
}
