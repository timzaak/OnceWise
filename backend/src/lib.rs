// The lib target lets tests/ integration tests reach AppState and the router assembly (a bin target
// cannot be imported by integration tests).

pub mod config;
pub mod db;
pub mod dto;
pub mod error;
pub mod openapi;
pub mod orgs;
pub mod routes;
pub mod spacekey;

use sqlx::PgPool;

use orgs::OrgClient;
use routes::auth::HeraldAuth;

/// Carries the connection pool plus the optional Herald sign-in gate: `auth: None` is the
/// explicit none mode (space-key only, the pre-gate behavior). `org` — the server-to-server
/// organization channel behind workspace permissions — is assembled exactly when `auth` is
/// (herald mode); the org-bound surface is mounted only then. Access control queries the
/// database per request; the only in-memory state is the short-lived login handshake inside
/// HeraldAuth.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub auth: Option<HeraldAuth>,
    pub org: Option<OrgClient>,
}
