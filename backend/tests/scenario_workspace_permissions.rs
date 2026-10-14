// Scenario tests for workspace permissions (w01–w08) against a REAL Herald ≥0.6.4 instance
// running in docker (scripts/test-start.py; image ghcr.io/timzaak/herald:0.6.4, overridable via
// HERALD_IMAGE). The org channel is exercised end to end: realms, the BFF client app, its
// bound API key (client_api_keys + orgs.view/orgs.manage policies) and the per-test users are
// seeded as idempotent SQL straight into Herald's own database — no doubles, no mocks, so any
// upstream drift fails these tests loudly. Outage cases stop/start the container; the
// last-admin guard needs Herald's documented anomalous state (owner membership absent) and is
// set up with the same surgical SQL cas-2's own integration suite uses.
//
// Environment (defaults match scripts/test-start.py):
//   TEST_HERALD_URL           Herald base URL        (http://127.0.0.1:13001)
//   TEST_HERALD_DATABASE_URL  Herald's PostgreSQL    (postgres://postgres:postgres@127.0.0.1:5432/herald_test)
//   TEST_HERALD_REDIS         Herald's Redis address (127.0.0.1:16381) — used only to clear
//                             login/authorize rate-limit keys between logins
// Business-endpoint cases still need TEST_DATABASE_URL / DATABASE_URL (scenario_data_sync.rs).
//
// The tests serialize on one mutex: w05/w06 stop the shared Herald container mid-run.
//
// Story mapping: w01–w08 correspond to US-WP-001～009 (docs/user-stories/auth/workspace-permissions.md).

mod common;

use axum::http::StatusCode;
use axum::Router;
use oncewise_ai_sync::routes::auth::HeraldAuth;
use oncewise_ai_sync::spacekey::sha256_hex;
use oncewise_ai_sync::{routes, AppState};
use serde_json::{json, Value};

use common::herald::{
    error_code, herald_base_url, herald_config, org_client, EnvRestore, Herald, CALLBACK_URI,
    CLIENT_ID, ENV_MUTEX, ENV_VARS, ORG_API_KEY, PASSWORD, REALM,
};
use common::{json_of, KEY_A, KEY_B};

/// Serializes the whole suite (w05/w06 stop the shared Herald container mid-run).
static SUITE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The api_key_hash Herald computes for the org-channel key (default salt v1).
fn api_key_hash(key: &str) -> String {
    let salted = format!("{key}:herald-api-key-salt-v1");
    format!("sha256:{}", sha256_hex(salted.as_bytes()))
}

impl Herald {
    /// Idempotent seed: the realm + BFF client app (shared shape with scenario_herald_auth),
    /// the org-channel API key with its orgs.view/orgs.manage role, and the per-test users.
    /// Leftover w-series organizations from earlier runs are dropped so membership state never
    /// leaks across runs (the local spaces database is fresh per run, Herald's is not); account
    /// status is reset so a disabled account from a previous run never leaks in.
    async fn seed(&self) {
        let users: &[&str] = &[
            "w01-owner@test.oncewise.local",
            "w01-other@test.oncewise.local",
            "w02-owner@test.oncewise.local",
            "w02-joiner@test.oncewise.local",
            "w02-rival@test.oncewise.local",
            "w02-third@test.oncewise.local",
            "w02-fourth@test.oncewise.local",
            "w03-owner@test.oncewise.local",
            "w03-member@test.oncewise.local",
            "w04-owner@test.oncewise.local",
            "w04-a@test.oncewise.local",
            "w04-b@test.oncewise.local",
            "w04-c@test.oncewise.local",
            "w05-owner@test.oncewise.local",
            "w06-owner@test.oncewise.local",
            "w06-joiner@test.oncewise.local",
            "w08-a@test.oncewise.local",
            "w08-b@test.oncewise.local",
        ];
        let mut user_sql = String::new();
        for email in users {
            user_sql.push_str(&format!(
                "\nINSERT INTO account (id, realm_id, email, password, status)\
                 \nVALUES (uuidv7(), '{REALM}', '{email}', v_hash, 1)\
                 \nON CONFLICT (realm_id, email) DO UPDATE SET status = 1;\
                 \nSELECT id INTO v_user FROM account WHERE realm_id = '{REALM}' AND email = '{email}';\
                 \nINSERT INTO profile (id, realm_id, nickname) VALUES (v_user, '{REALM}', 'W Test User')\
                 \nON CONFLICT (id, realm_id) DO NOTHING;\
                 \nINSERT INTO user_agreement_consent (id, user_id, realm_id, agreement_type, consented_version_id)\
                 \nSELECT uuidv7(), v_user, '{REALM}', v.agreement_type, v.id FROM legal_agreement_version v\
                 \nWHERE v.id IN (SELECT DISTINCT ON (lv.agreement_type) lv.id FROM legal_agreement_version lv\
                 \n  WHERE (lv.realm_id IS NULL OR lv.realm_id = '{REALM}')\
                 \n  ORDER BY lv.agreement_type, (lv.realm_id IS NULL), lv.version_no DESC)\
                 \nON CONFLICT (user_id, agreement_type) DO UPDATE SET\
                 \n  consented_version_id = EXCLUDED.consented_version_id, consented_at = CURRENT_TIMESTAMP;"
            ));
        }
        let key_hash = api_key_hash(ORG_API_KEY);
        let sql = format!(
            "DO $$\
             \nDECLARE v_hash text; v_user uuid; v_client_app uuid; v_key_id text; v_role uuid;\
             \nBEGIN\
             \n  SELECT password INTO v_hash FROM account WHERE realm_id = 'admin' LIMIT 1;\
             \n  DELETE FROM organizations WHERE realm_id = '{REALM}' AND external_id LIKE 'sp-w%';\
             \n  INSERT INTO realm (id, name) VALUES ('{REALM}', 'OnceWise Test') ON CONFLICT (id) DO NOTHING;\
             \n  INSERT INTO client_app (id, realm_id, client_id, name, redirect_uris)\
             \n  VALUES (uuidv7(), '{REALM}', '{CLIENT_ID}', 'OnceWise Sync BFF', '[\"{CALLBACK_URI}\"]'::jsonb)\
             \n  ON CONFLICT (realm_id, client_id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris;\
             \n  SELECT id INTO v_client_app FROM client_app WHERE realm_id = '{REALM}' AND client_id = '{CLIENT_ID}';\
             \n  INSERT INTO client_api_keys (id, name, api_key_hash, realm_id, client_app_id, enabled)\
             \n  VALUES ('ow-test-org-api-key-w', 'oncewise org channel test key', '{key_hash}', '{REALM}', v_client_app, true)\
             \n  ON CONFLICT (api_key_hash) DO UPDATE SET client_app_id = EXCLUDED.client_app_id, enabled = true;\
             \n  SELECT id INTO v_key_id FROM client_api_keys WHERE api_key_hash = '{key_hash}';\
             \n  INSERT INTO roles (id, name, description, realm_id, client_id, is_builtin)\
             \n  VALUES (uuidv7(), 'oncewise-org-channel', 'org channel policies for the sync BFF key', '{REALM}', '{CLIENT_ID}', false)\
             \n  ON CONFLICT (name, realm_id, client_id) DO NOTHING;\
             \n  SELECT id INTO v_role FROM roles WHERE name = 'oncewise-org-channel' AND realm_id = '{REALM}' AND client_id = '{CLIENT_ID}';\
             \n  INSERT INTO role_policies (id, role_id, realm_id, resource, action)\
             \n  VALUES (uuidv7(), v_role, '{REALM}', 'orgs', 'view'), (uuidv7(), v_role, '{REALM}', 'orgs', 'manage')\
             \n  ON CONFLICT (role_id, resource, action) DO NOTHING;\
             \n  INSERT INTO user_roles (id, user_id, role_id, realm_id, client_id, principal_type, principal_id)\
             \n  VALUES (uuidv7(), NULL, v_role, '{REALM}', '{CLIENT_ID}', 'api_key', v_key_id)\
             \n  ON CONFLICT (realm_id, principal_type, principal_id, role_id) WHERE source = 'manual' DO NOTHING;\
             {user_sql}\
             \nEND $$;"
        );
        sqlx::raw_sql(&sql)
            .execute(&self.db)
            .await
            .expect("Herald seed failed (is the image schema at the expected version?)");
    }

    async fn login(&self, email: &str) -> String {
        self.clear_rate_limits();
        let response = self
            .http
            .post(format!("{}/api/auth/{REALM}/login", self.base))
            .json(&json!({
                "email": email,
                "password": PASSWORD,
                "clientId": CLIENT_ID,
            }))
            .send()
            .await
            .expect(
                "Herald login request failed; is the test Herald running? (scripts/test-start.py)",
            );
        let body = response.text().await.expect("login body");
        let value: Value = serde_json::from_str(&body)
            .unwrap_or_else(|_| panic!("Herald login response was not JSON: {body}"));
        assert!(
            value.get("accessToken").is_some(),
            "Herald login did not issue a token for {email}: {body}"
        );
        format!(
            "Bearer {}",
            value["accessToken"].as_str().expect("accessToken")
        )
    }

    async fn user_id(&self, email: &str) -> String {
        sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM account WHERE realm_id = $1 AND email = $2",
        )
        .bind(REALM)
        .bind(email)
        .fetch_one(&self.db)
        .await
        .expect("seeded user id")
    }

    /// (org id, owner user id) of the organization bound to a space id — the Herald-side fact.
    async fn org_of(&self, external_id: &str) -> Option<(String, String)> {
        sqlx::query_as::<_, (String, String)>(
            "SELECT o.id::text, o.owner_user_id::text FROM organizations o \
             JOIN client_app a ON a.id = o.client_app_id \
             WHERE o.realm_id = $1 AND a.realm_id = $1 AND a.client_id = $2 AND o.external_id = $3",
        )
        .bind(REALM)
        .bind(CLIENT_ID)
        .bind(external_id)
        .fetch_optional(&self.db)
        .await
        .expect("org lookup")
    }

    /// Herald's tier name for a membership (org-owner / org-admin / org-member).
    async fn tier_of(&self, org_id: &str, email: &str) -> Option<String> {
        sqlx::query_scalar::<_, String>(
            "SELECT r.name FROM org_memberships m JOIN roles r ON r.id = m.role_id \
             JOIN account u ON u.id = m.user_id \
             WHERE m.org_id = $1::uuid AND u.realm_id = $2 AND u.email = $3",
        )
        .bind(org_id)
        .bind(REALM)
        .bind(email)
        .fetch_optional(&self.db)
        .await
        .expect("membership tier lookup")
    }

    /// The documented anomalous state in which Herald's last-admin guard is reachable: the
    /// owner's membership row absent (cas-2's own integration suite sets up the same state).
    async fn anomalously_drop_owner_membership(&self, org_id: &str, owner_email: &str) {
        let owner = self.user_id(owner_email).await;
        sqlx::query("DELETE FROM org_memberships WHERE org_id = $1::uuid AND user_id = $2::uuid")
            .bind(org_id)
            .bind(owner)
            .execute(&self.db)
            .await
            .expect("anomalous-state setup");
    }
}

struct TestApp {
    app: Router,
    pool: sqlx::PgPool,
}

async fn spawn_herald(base_url: &str) -> TestApp {
    let pool = common::migrated_pool().await;
    let auth = HeraldAuth::new(herald_config(base_url)).expect("herald assembly");
    TestApp {
        app: routes::build_router(AppState {
            pool: pool.clone(),
            auth: Some(auth),
            org: Some(org_client(base_url)),
        }),
        pool,
    }
}

async fn spawn_none() -> TestApp {
    let pool = common::migrated_pool().await;
    TestApp {
        app: routes::build_router(AppState {
            pool: pool.clone(),
            auth: None,
            org: None,
        }),
        pool,
    }
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let headers: Vec<(&str, &str)> = bearer
        .map(|b| vec![("authorization", b)])
        .unwrap_or_default();
    let (status, _, bytes) = common::send(app, method, uri, &headers, body).await;
    (status, json_of(&bytes))
}

async fn call_with_key(
    app: &Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    key: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut headers: Vec<(&str, &str)> = vec![("x-space-key", key)];
    if let Some(bearer) = bearer {
        headers.push(("authorization", bearer));
    }
    let (status, _, bytes) = common::send(app, method, uri, &headers, body).await;
    (status, json_of(&bytes))
}

/// POST /api/spaces without a key — the org-bound creation path. Asserts 201 + owner facts.
async fn create_org_space(app: &Router, bearer: &str, space_id: &str) -> Value {
    let (status, body) = call(
        app,
        "POST",
        "/api/spaces",
        Some(bearer),
        Some(json!({ "id": space_id, "name": "WP Space" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "org-bound creation failed: {body}"
    );
    body
}

async fn issue_invite(app: &Router, bearer: &str, space_id: &str) -> String {
    let (status, body) = call(
        app,
        "POST",
        &format!("/api/spaces/{space_id}/invites"),
        Some(bearer),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "invite issue failed: {body}");
    let code = body["code"].as_str().expect("code").to_string();
    assert!(
        code.starts_with(&format!("{space_id}#iv-")) && code.len() == space_id.len() + 36,
        "invite code wire shape: {code}"
    );
    code
}

async fn redeem(app: &Router, bearer: Option<&str>, code: &str) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        "/api/invites/redeem",
        bearer,
        Some(json!({ "code": code })),
    )
    .await
}

async fn set_member_role(
    app: &Router,
    bearer: &str,
    space_id: &str,
    user_id: &str,
    role: &str,
) -> (StatusCode, Value) {
    call(
        app,
        "PATCH",
        &format!("/api/spaces/{space_id}/members/{user_id}"),
        Some(bearer),
        Some(json!({ "role": role })),
    )
    .await
}

async fn list_members(
    app: &Router,
    bearer: &str,
    space_id: &str,
    query: &str,
) -> (StatusCode, Value) {
    call(
        app,
        "GET",
        &format!("/api/spaces/{space_id}/members{query}"),
        Some(bearer),
        None,
    )
    .await
}

async fn remove_member(
    app: &Router,
    bearer: &str,
    space_id: &str,
    user_id: &str,
) -> (StatusCode, Value) {
    call(
        app,
        "DELETE",
        &format!("/api/spaces/{space_id}/members/{user_id}"),
        Some(bearer),
        None,
    )
    .await
}

async fn transfer(
    app: &Router,
    bearer: &str,
    space_id: &str,
    user_id: &str,
) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/api/spaces/{space_id}/ownership"),
        Some(bearer),
        Some(json!({ "userId": user_id })),
    )
    .await
}

/// Pushes a locally-issued invite past its expiry (fixed-width text: lexicographic order is
/// chronological order). The hash input is the server's own sha256_hex over the full code —
/// locked to the same implementation, never a parallel one.
async fn expire_invite(app: &TestApp, code: &str) {
    sqlx::query(
        "UPDATE space_invites SET expires_at = '2001-01-01T00:00:00.000Z' WHERE code_hash = $1",
    )
    .bind(sha256_hex(code.as_bytes()))
    .execute(&app.pool)
    .await
    .expect("invite expiry shift");
}

fn script_body(script_id: &str) -> Value {
    json!({ "id": script_id, "name": "F", "flowContent": {"v": 1} })
}

// ---------------------------------------------------------------------------
// w01 — org-bound creation and role visibility
// ---------------------------------------------------------------------------

// Covers US-WP-001: creating a space without a key binds a Herald organization with the
// creator as owner — atomically (a Herald failure leaves nothing behind), with myRole/myUserId
// visible on create and get; key-addressed creation coexists unchanged; replay converges for
// members and denies anyone else; none mode keeps creating key spaces only and does not mount
// the workspace endpoints.
#[tokio::test]
async fn w01_org_bound_creation_and_role_visibility() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    let owner = herald.login("w01-owner@test.oncewise.local").await;
    let owner_id = herald.user_id("w01-owner@test.oncewise.local").await;

    let space = "sp-w01-000000000001";
    let body = create_org_space(&app.app, &owner, space).await;
    assert_eq!(body["myRole"], json!("owner"));
    assert_eq!(body["myUserId"], json!(owner_id));
    assert_eq!(body["id"], json!(space));

    // The Herald-side fact: an organization exists for this space, owned by the creator.
    let (_, org_owner) = herald.org_of(space).await.expect("organization must exist");
    assert_eq!(org_owner, owner_id);

    // get_space without (and with a nonsense) X-Space-Key: membership is the credential.
    let (status, body) = call(
        &app.app,
        "GET",
        &format!("/api/spaces/{space}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["myRole"], json!("owner"));
    assert_eq!(body["myUserId"], json!(owner_id));
    for junk_key in ["garbage", KEY_B] {
        let (status, body) = call_with_key(
            &app.app,
            "GET",
            &format!("/api/spaces/{space}"),
            Some(&owner),
            junk_key,
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "org-bound spaces ignore X-Space-Key ({junk_key})"
        );
        assert_eq!(body["myRole"], json!("owner"));
    }

    // Key-addressed creation on the same deployment: byte-identical old behavior, no my* fields.
    let (status, body) = call(
        &app.app,
        "POST",
        "/api/spaces",
        Some(&owner),
        Some(json!({ "id": "sp-w01-000000000002", "key": KEY_A, "name": "Key Space" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(body.get("myRole").is_none() && body.get("myUserId").is_none());
    let (status, body) = call_with_key(
        &app.app,
        "GET",
        "/api/spaces/sp-w01-000000000002",
        Some(&owner),
        KEY_A,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.get("myRole").is_none() && body.get("myUserId").is_none());

    // Idempotent replay by a member converges on 200 with the actual role.
    let (status, body) = call(
        &app.app,
        "POST",
        "/api/spaces",
        Some(&owner),
        Some(json!({ "id": space, "name": "WP Space" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["myRole"], json!("owner"));

    // Anyone else hitting the same id gets the get_space denial — no id probing.
    let other = herald.login("w01-other@test.oncewise.local").await;
    let (status, body) = call(
        &app.app,
        "POST",
        "/api/spaces",
        Some(&other),
        Some(json!({ "id": space, "name": "WP Space" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "SPACE_ACCESS_DENIED");

    // A key-space id without its key is a mismatch, not an org-bound creation.
    let (status, body) = call(
        &app.app,
        "POST",
        "/api/spaces",
        Some(&other),
        Some(json!({ "id": "sp-w01-000000000002", "name": "Key Space" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "SPACE_KEY_MISMATCH");

    // none mode: no key → 400; the workspace endpoints are not mounted (404).
    let none_app = spawn_none().await;
    let (status, body) = call(
        &none_app.app,
        "POST",
        "/api/spaces",
        None,
        Some(json!({ "id": "sp-w01-000000000003", "name": "T" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "INVALID_INPUT");
    for (method, uri) in [
        ("POST", "/api/invites/redeem"),
        ("POST", "/api/spaces/sp-w01-000000000001/invites"),
        ("GET", "/api/spaces/sp-w01-000000000001/members"),
        ("PATCH", "/api/spaces/sp-w01-000000000001/members/u"),
        ("DELETE", "/api/spaces/sp-w01-000000000001/members/u"),
        ("POST", "/api/spaces/sp-w01-000000000001/ownership"),
    ] {
        let (status, body) = call(&none_app.app, method, uri, None, Some(json!({}))).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "{method} {uri} must be absent in none mode"
        );
        assert_eq!(error_code(&body), "NOT_FOUND");
    }

    // Herald down: org-bound creation fails closed with no half-made space.
    herald.stop_container().await;
    let (status, body) = call(
        &app.app,
        "POST",
        "/api/spaces",
        Some(&owner),
        Some(json!({ "id": "sp-w01-000000000004", "name": "T" })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&body), "AUTH_UNAVAILABLE");
    herald.start_container_and_wait().await;
    let gone = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM spaces WHERE id = 'sp-w01-000000000004'",
    )
    .fetch_one(&app.pool)
    .await
    .expect("local row count");
    assert_eq!(gone, 0, "a failed creation must leave no row behind");
    let leftover = herald.org_of("sp-w01-000000000004").await;
    assert!(
        leftover.is_none(),
        "a failed creation must leave no organization behind"
    );
}

// ---------------------------------------------------------------------------
// w02 — invite lifecycle
// ---------------------------------------------------------------------------

// Covers US-WP-002/003: one-time invite codes — single atomic consumption, 24 h validity,
// several codes coexisting, invalid/expired/used distinctions, concurrent redemption letting
// exactly one in, unauthenticated attempts not consuming, and members re-redeeming converging
// without consumption or demotion.
#[tokio::test]
async fn w02_invite_lifecycle() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    let owner = herald.login("w02-owner@test.oncewise.local").await;
    let joiner = herald.login("w02-joiner@test.oncewise.local").await;
    let joiner_id = herald.user_id("w02-joiner@test.oncewise.local").await;
    let rival = herald.login("w02-rival@test.oncewise.local").await;
    let third = herald.login("w02-third@test.oncewise.local").await;
    let fourth = herald.login("w02-fourth@test.oncewise.local").await;
    let fourth_id = herald.user_id("w02-fourth@test.oncewise.local").await;

    let space = "sp-w02-000000000001";
    create_org_space(&app.app, &owner, space).await;
    let (org_id, _) = herald.org_of(space).await.expect("org");

    // Unauthenticated redemption is refused at the gate and the code survives.
    let code = issue_invite(&app.app, &owner, space).await;
    let (status, body) = redeem(&app.app, None, &code).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&body), "AUTH_REQUIRED");

    // First redemption joins as a read-only member with the caller's own id.
    let (status, body) = redeem(&app.app, Some(&joiner), &code).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["myRole"], json!("member"));
    assert_eq!(body["myUserId"], json!(joiner_id));
    assert_eq!(
        herald
            .tier_of(&org_id, "w02-joiner@test.oncewise.local")
            .await
            .as_deref(),
        Some("org-member")
    );

    // The spent code answers a non-member with 409.
    let (status, body) = redeem(&app.app, Some(&rival), &code).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "INVITE_ALREADY_USED");

    // A member re-redeeming the spent code converges on the idempotent 200.
    let (status, body) = redeem(&app.app, Some(&joiner), &code).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["myRole"], json!("member"));

    // Expired: a fresh code pushed past its window is INVITE_EXPIRED, distinct from invalid.
    let expiring = issue_invite(&app.app, &owner, space).await;
    expire_invite(&app, &expiring).await;
    let (status, body) = redeem(&app.app, Some(&rival), &expiring).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "INVITE_EXPIRED");

    // Invalid: malformed and well-formed-but-unknown codes get one stable answer.
    for bad in [
        "",
        "not-a-code",
        &format!("{space}#zz-{}", "x".repeat(32)),
        &format!("sp-w02-00000000000X#iv-{}", "x".repeat(32)),
        &format!("{space}#iv-{}", "x".repeat(31)),
    ] {
        let (status, body) = redeem(&app.app, Some(&rival), bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?}");
        assert_eq!(error_code(&body), "INVITE_INVALID");
    }

    // Several codes for one space coexist; a member re-redeeming a FRESH code does not consume
    // it and keeps their actual role.
    let member_code = issue_invite(&app.app, &owner, space).await;
    let (status, body) = redeem(&app.app, Some(&joiner), &member_code).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["myRole"],
        json!("member"),
        "re-redeeming must not demote or re-grant"
    );
    let (status, body) = redeem(&app.app, Some(&fourth), &member_code).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "an unconsumed code must still admit someone else: {body}"
    );
    assert_eq!(body["myRole"], json!("member"));
    assert_eq!(body["myUserId"], json!(fourth_id));

    // Concurrency: two callers race one code — the row lock lets exactly one in.
    let race_code = issue_invite(&app.app, &owner, space).await;
    let (a, b) = tokio::join!(
        redeem(&app.app, Some(&rival), &race_code),
        redeem(&app.app, Some(&third), &race_code)
    );
    let outcomes = [(&a.0, &a.1), (&b.0, &b.1)];
    assert_eq!(
        outcomes
            .iter()
            .filter(|(status, _)| **status == StatusCode::OK)
            .count(),
        1,
        "exactly one concurrent redemption may succeed: {outcomes:?}"
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|(_, body)| error_code(body) == "INVITE_ALREADY_USED")
            .count(),
        1
    );
}

// ---------------------------------------------------------------------------
// w03 — role-gated access to scripts
// ---------------------------------------------------------------------------

// Covers US-WP-004: read semantics stay open to every member, writes and management need the
// admin tier (403 SPACE_ROLE_REQUIRED with a distinguishable code), promotion opens writes and
// demotion closes them on the very next request.
#[tokio::test]
async fn w03_role_gated_access() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    let owner = herald.login("w03-owner@test.oncewise.local").await;
    let member = herald.login("w03-member@test.oncewise.local").await;
    let member_id = herald.user_id("w03-member@test.oncewise.local").await;

    let space = "sp-w03-000000000001";
    let script = "sc-w03-000000000001";
    create_org_space(&app.app, &owner, space).await;
    let code = issue_invite(&app.app, &owner, space).await;
    let (status, body) = redeem(&app.app, Some(&member), &code).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Owner writes v1 for the member to read.
    let (status, body) = call(
        &app.app,
        "POST",
        &format!("/api/spaces/{space}/scripts"),
        Some(&owner),
        Some(script_body(script)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // Reads are member-open: list, versions, one version's content.
    for uri in [
        format!("/api/spaces/{space}/scripts"),
        format!("/api/spaces/{space}/scripts/{script}/versions"),
        format!("/api/spaces/{space}/scripts/{script}/versions/1"),
    ] {
        let (status, _) = call(&app.app, "GET", &uri, Some(&member), None).await;
        assert_eq!(status, StatusCode::OK, "member read {uri}");
    }

    // Writes and management are admin-tier: a read-only member gets SPACE_ROLE_REQUIRED.
    for (method, uri, body_send) in [
        (
            "POST",
            format!("/api/spaces/{space}/scripts"),
            Some(script_body("sc-w03-000000000002")),
        ),
        (
            "PATCH",
            format!("/api/spaces/{space}/scripts/{script}"),
            Some(json!({ "name": "F2" })),
        ),
        (
            "POST",
            format!("/api/spaces/{space}/scripts/{script}/versions"),
            Some(json!({ "flowContent": {"v": 2} })),
        ),
        ("DELETE", format!("/api/spaces/{space}"), None),
        ("POST", format!("/api/spaces/{space}/invites"), None),
        ("GET", format!("/api/spaces/{space}/members"), None),
    ] {
        let (status, body) = call(&app.app, method, &uri, Some(&member), body_send).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "{method} {uri} as read-only member: {body}"
        );
        assert_eq!(error_code(&body), "SPACE_ROLE_REQUIRED");
    }

    // Promotion opens the write path…
    let (status, body) = set_member_role(&app.app, &owner, space, &member_id, "admin").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["role"], json!("admin"));
    let (status, body) = call(
        &app.app,
        "POST",
        &format!("/api/spaces/{space}/scripts/{script}/versions"),
        Some(&member),
        Some(json!({ "flowContent": {"v": 2} })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // …and demotion closes it again on the next request (no cache window).
    let (status, body) = set_member_role(&app.app, &owner, space, &member_id, "member").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call(
        &app.app,
        "POST",
        &format!("/api/spaces/{space}/scripts/{script}/versions"),
        Some(&member),
        Some(json!({ "flowContent": {"v": 3} })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "SPACE_ROLE_REQUIRED");
}

// ---------------------------------------------------------------------------
// w04 — member management and protections
// ---------------------------------------------------------------------------

// Covers US-WP-005/006: the live member list (display fields, roles, owner marker), removal
// taking effect on the removed member's next request, owner protection (removal, demotion,
// self-exit), ownership transfer as one atomic step, member self-exit, missing targets answering
// 404, and the last-admin guard in Herald's documented anomalous state.
#[tokio::test]
async fn w04_member_management_and_protections() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    let owner = herald.login("w04-owner@test.oncewise.local").await;
    let owner_id = herald.user_id("w04-owner@test.oncewise.local").await;
    let a = herald.login("w04-a@test.oncewise.local").await;
    let a_id = herald.user_id("w04-a@test.oncewise.local").await;
    let b = herald.login("w04-b@test.oncewise.local").await;
    let b_id = herald.user_id("w04-b@test.oncewise.local").await;
    let c = herald.login("w04-c@test.oncewise.local").await;
    let c_id = herald.user_id("w04-c@test.oncewise.local").await;

    let space = "sp-w04-000000000001";
    create_org_space(&app.app, &owner, space).await;
    for bearer in [&a, &b] {
        let code = issue_invite(&app.app, &owner, space).await;
        let (status, body) = redeem(&app.app, Some(bearer), &code).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, body) = set_member_role(&app.app, &owner, space, &a_id, "admin").await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The member list is fetched live with display fields and correct tiers.
    let (status, body) = list_members(&app.app, &owner, space, "").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let items = body["items"].as_array().expect("items");
    assert_eq!(body["total"], json!(items.len() as i64));
    let by_id = |body: &Value, id: &str| {
        body["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|m| m["userId"] == json!(id))
            .cloned()
            .unwrap_or_else(|| panic!("member {id} missing from list: {body}"))
    };
    let owner_row = by_id(&body, &owner_id);
    assert_eq!(owner_row["role"], json!("owner"));
    assert_eq!(owner_row["isOwner"], json!(true));
    assert!(owner_row["email"].is_string() && owner_row["nickname"].is_string());
    assert_eq!(by_id(&body, &a_id)["role"], json!("admin"));
    assert_eq!(by_id(&body, &a_id)["isOwner"], json!(false));
    assert_eq!(by_id(&body, &b_id)["role"], json!("member"));

    // Pagination mirrors the upstream bounds.
    let (status, body) = list_members(&app.app, &owner, space, "?page=1&pageSize=2").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().map(Vec::len), Some(2));
    assert_eq!(body["page"], json!(1));
    assert_eq!(body["pageSize"], json!(2));
    for bad in [
        "?page=0",
        "?pageSize=0",
        "?pageSize=101",
        "?page=x",
        "?other=1",
    ] {
        let (status, body) = list_members(&app.app, &owner, space, bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {body}");
        assert_eq!(error_code(&body), "INVALID_INPUT");
    }

    // A read-only member may not list members.
    let (status, body) = list_members(&app.app, &b, space, "").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "SPACE_ROLE_REQUIRED");

    // Removal is near-immediate: the removed member's next request is denied.
    let (status, body) = remove_member(&app.app, &owner, space, &b_id).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (status, body) = call(
        &app.app,
        "GET",
        &format!("/api/spaces/{space}"),
        Some(&b),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "SPACE_ACCESS_DENIED");
    // Removing a non-member is 404, not a silent success.
    let (status, body) = remove_member(&app.app, &owner, space, &b_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "MEMBER_NOT_FOUND");
    // Role change on a non-member target is 404 too (the invite code is the only join path).
    let (status, body) = set_member_role(&app.app, &owner, space, &b_id, "admin").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "MEMBER_NOT_FOUND");

    // Owner protection: no removal, no demotion, no self-exit.
    let (status, body) = remove_member(&app.app, &a, space, &owner_id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "SPACE_OWNER_PROTECTED");
    let (status, body) = set_member_role(&app.app, &owner, space, &owner_id, "member").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "SPACE_OWNER_PROTECTED");
    let (status, body) = remove_member(&app.app, &owner, space, &owner_id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "SPACE_OWNER_PROTECTED");
    // "owner" as a role value is a 400 — ownership only moves via the transfer endpoint.
    let (status, body) = set_member_role(&app.app, &owner, space, &a_id, "owner").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "INVALID_INPUT");

    // Only the owner may transfer; the target must be a member.
    let (status, body) = transfer(&app.app, &a, space, &owner_id).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "SPACE_ROLE_REQUIRED");
    let outsider = herald.user_id("w01-other@test.oncewise.local").await;
    let (status, body) = transfer(&app.app, &owner, space, &outsider).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "MEMBER_NOT_FOUND");

    // Transfer is one atomic step: new owner up, previous owner on admin, list reflects both.
    let (status, body) = transfer(&app.app, &owner, space, &a_id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["userId"], json!(a_id));
    assert_eq!(body["role"], json!("owner"));
    assert_eq!(body["isOwner"], json!(true));
    let (status, body) = list_members(&app.app, &a, space, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(by_id(&body, &a_id)["role"], json!("owner"));
    assert_eq!(by_id(&body, &a_id)["isOwner"], json!(true));
    assert_eq!(by_id(&body, &owner_id)["role"], json!("admin"));
    let (org_id, _) = herald.org_of(space).await.expect("org");
    assert_eq!(
        herald
            .tier_of(&org_id, "w04-owner@test.oncewise.local")
            .await
            .as_deref(),
        Some("org-admin"),
        "the previous owner must land on the admin tier in the same step"
    );

    // Self-exit: a read-only member may leave on their own addressing.
    let space_b = "sp-w04-000000000002";
    create_org_space(&app.app, &owner, space_b).await;
    let code = issue_invite(&app.app, &owner, space_b).await;
    let (status, body) = redeem(&app.app, Some(&c), &code).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = remove_member(&app.app, &c, space_b, &c_id).await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "read-only self-exit: {body}"
    );
    let (status, body) = call(
        &app.app,
        "GET",
        &format!("/api/spaces/{space_b}"),
        Some(&c),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "SPACE_ACCESS_DENIED");

    // Last-admin guard: with the owner's membership anomalously absent (the only state with no
    // other admin-tier member), the last admin can neither leave nor be demoted. c rejoins and
    // is promoted first.
    let (org_b, _) = herald.org_of(space_b).await.expect("org");
    let rejoin_code = issue_invite(&app.app, &owner, space_b).await;
    let (status, body) = redeem(&app.app, Some(&c), &rejoin_code).await;
    assert_eq!(status, StatusCode::OK, "rejoin for the promotion: {body}");
    let (status, body) = set_member_role(&app.app, &owner, space_b, &c_id, "admin").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    herald
        .anomalously_drop_owner_membership(&org_b, "w04-owner@test.oncewise.local")
        .await;
    let (status, body) = remove_member(&app.app, &c, space_b, &c_id).await;
    assert_eq!(status, StatusCode::CONFLICT, "last-admin self-exit: {body}");
    assert_eq!(error_code(&body), "SPACE_LAST_ADMIN_PROTECTED");
    let (status, body) = set_member_role(&app.app, &c, space_b, &c_id, "member").await;
    assert_eq!(status, StatusCode::CONFLICT, "last-admin demotion: {body}");
    assert_eq!(error_code(&body), "SPACE_LAST_ADMIN_PROTECTED");
}

// ---------------------------------------------------------------------------
// w05 — deletion cascade
// ---------------------------------------------------------------------------

// Covers US-WP-007 deletion semantics for org-bound spaces: deleting is an admin-tier act that
// removes the Herald organization (memberships cascade there), invalidates outstanding invites
// via the local FK cascade, and fails closed leaving everything intact while Herald is down.
#[tokio::test]
async fn w05_deletion_cascade() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    let owner = herald.login("w05-owner@test.oncewise.local").await;
    let member = herald.login("w06-joiner@test.oncewise.local").await;

    let space = "sp-w05-000000000001";
    create_org_space(&app.app, &owner, space).await;
    let code = issue_invite(&app.app, &owner, space).await;
    let (status, body) = redeem(&app.app, Some(&member), &code).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let _ = herald.org_of(space).await.expect("org");

    // A member (read-only) cannot delete; the owner (admin-tier) can.
    let (status, body) = call(
        &app.app,
        "DELETE",
        &format!("/api/spaces/{space}"),
        Some(&member),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "SPACE_ROLE_REQUIRED");

    // Outage: deletion fails closed and the space plus organization stay fully intact.
    herald.stop_container().await;
    let (status, body) = call(
        &app.app,
        "DELETE",
        &format!("/api/spaces/{space}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&body), "AUTH_UNAVAILABLE");
    herald.start_container_and_wait().await;
    let (status, _) = call(
        &app.app,
        "GET",
        &format!("/api/spaces/{space}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a failed deletion must leave the space visible"
    );
    assert!(herald.org_of(space).await.is_some());

    // Successful deletion: 204, organization gone in Herald, outstanding code dead.
    let (status, body) = call(
        &app.app,
        "DELETE",
        &format!("/api/spaces/{space}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert!(
        herald.org_of(space).await.is_none(),
        "the organization must be gone"
    );
    let (status, _) = call(
        &app.app,
        "GET",
        &format!("/api/spaces/{space}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = redeem(
        &app.app,
        Some(&herald.login("w02-rival@test.oncewise.local").await),
        &code,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        error_code(&body),
        "INVITE_INVALID",
        "deleted-space codes must be inert"
    );

    // Repeat delete: the local row is gone; the id can be recreated fresh.
    let (status, _) = call(
        &app.app,
        "DELETE",
        &format!("/api/spaces/{space}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    create_org_space(&app.app, &owner, space).await;
}

// ---------------------------------------------------------------------------
// w06 — fail-closed and identity invalidation
// ---------------------------------------------------------------------------

// Covers US-WP-009: every workspace operation fails closed while Herald is down (the invite
// code is not consumed), a disabled member account is rejected at the gate on its next
// request, and the public endpoints never depend on the provider.
#[tokio::test]
async fn w06_fail_closed_and_identity_invalidation() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    let owner = herald.login("w06-owner@test.oncewise.local").await;
    let joiner = herald.login("w06-joiner@test.oncewise.local").await;
    let rival = herald.login("w02-rival@test.oncewise.local").await;

    let space = "sp-w06-000000000001";
    create_org_space(&app.app, &owner, space).await;
    let code = issue_invite(&app.app, &owner, space).await;
    let (status, body) = redeem(&app.app, Some(&joiner), &code).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A disabled account is rejected on the very next request (gate semantics, 401).
    herald
        .set_account_status(REALM, "w06-joiner@test.oncewise.local", 2)
        .await;
    let (status, body) = call(
        &app.app,
        "GET",
        &format!("/api/spaces/{space}"),
        Some(&joiner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&body), "AUTH_REQUIRED");
    herald
        .set_account_status(REALM, "w06-joiner@test.oncewise.local", 1)
        .await;

    // Outage: every workspace operation fails closed; the invite survives it.
    let outage_code = issue_invite(&app.app, &owner, space).await;
    let _ = herald.org_of(space).await.expect("org");
    herald.stop_container().await;
    for uri in [
        format!("/api/spaces/{space}"),
        format!("/api/spaces/{space}/scripts"),
        format!("/api/spaces/{space}/invites"),
        format!("/api/spaces/{space}/members"),
    ] {
        let (status, body) = call(&app.app, "GET", &uri, Some(&owner), None).await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "outage: GET {uri}: {body}"
        );
        assert_eq!(error_code(&body), "AUTH_UNAVAILABLE");
    }
    let (status, body) = call(
        &app.app,
        "POST",
        &format!("/api/spaces/{space}/invites"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(error_code(&body), "AUTH_UNAVAILABLE");
    let (status, body) = redeem(&app.app, Some(&rival), &outage_code).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&body), "AUTH_UNAVAILABLE");
    for uri in ["/api/health", "/api/auth/config", "/api/openapi.json"] {
        let (status, _) = call(&app.app, "GET", uri, None, None).await;
        assert_eq!(status, StatusCode::OK, "{uri} must not depend on Herald");
    }

    // Recovery: the same code still admits its redeemer — the outage never burned it.
    herald.start_container_and_wait().await;
    let (status, body) = redeem(&app.app, Some(&rival), &outage_code).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["myRole"], json!("member"));
}

// ---------------------------------------------------------------------------
// w07 — configuration fail-fast
// ---------------------------------------------------------------------------

// Covers US-WP-008: a herald-mode deployment missing HERALD_ORG_API_KEY fails at startup with
// the variable named, the three console preparation steps and the AUTH_MODE=none exit — and no
// configured value is ever echoed back.
#[tokio::test]
async fn w07_org_api_key_fail_fast() {
    let _suite = SUITE.lock().await;
    let _guard = ENV_MUTEX.lock().unwrap();
    let _restore = EnvRestore::scoped(&ENV_VARS);
    std::env::set_var("DATABASE_URL", "postgres://user:pass@127.0.0.1:5432/db");

    // Only the base URL is configured: the other four are named, the console steps and both
    // exits are offered, and the secret value never appears.
    std::env::set_var("HERALD_BASE_URL", "https://herald.secret-example.invalid");
    let err = oncewise_ai_sync::config::Config::from_env()
        .expect_err("missing Herald config must fail")
        .to_string();
    assert!(err.contains("AUTH_MODE defaults to 'herald'"), "{err}");
    assert!(
        err.contains(
            "Missing variables: HERALD_REALM_ID, HERALD_CLIENT_ID, HERALD_REDIRECT_URI, HERALD_ORG_API_KEY"
        ),
        "{err}"
    );
    assert!(err.contains("workspace permissions"), "{err}");
    assert!(
        err.contains("Prepare HERALD_ORG_API_KEY in the Herald console:"),
        "{err}"
    );
    for step in ["1. Reuse", "2. Issue an API key", "3. Create a role"] {
        assert!(
            err.contains(step),
            "console step {step:?} must be in the error: {err}"
        );
    }
    assert!(
        err.contains("orgs.view") && err.contains("orgs.manage"),
        "{err}"
    );
    assert!(
        err.contains("AUTH_MODE=none"),
        "both exits must be offered: {err}"
    );
    assert!(
        !err.contains("secret-example"),
        "values must never be echoed: {err}"
    );

    // Four of five present: exactly the org key is named.
    std::env::set_var("HERALD_BASE_URL", "https://herald.example.com");
    std::env::set_var("HERALD_REALM_ID", REALM);
    std::env::set_var("HERALD_CLIENT_ID", CLIENT_ID);
    std::env::set_var(
        "HERALD_REDIRECT_URI",
        "https://sync.example.com/api/auth/oauth/callback",
    );
    let err = oncewise_ai_sync::config::Config::from_env()
        .expect_err("missing org key must fail")
        .to_string();
    assert!(
        err.contains("Missing variables: HERALD_ORG_API_KEY"),
        "{err}"
    );
    assert_eq!(
        err.matches("HERALD_").count(),
        err.matches("HERALD_ORG_API_KEY").count() + err.matches("HERALD_CLIENT_ID").count(),
        "only the missing variable and the console step's client-id reference may appear: {err}"
    );

    // Malformed org keys fail fast naming the variable, never the value.
    for value in ["", "   ", &"k".repeat(4097)] {
        std::env::set_var("HERALD_ORG_API_KEY", value);
        let err = oncewise_ai_sync::config::Config::from_env()
            .expect_err("malformed org key must fail")
            .to_string();
        assert!(err.contains("HERALD_ORG_API_KEY"), "{err}");
        assert!(!err.contains("kkkk"), "values must never be echoed: {err}");
    }

    // A complete five-variable set assembles the gate and the org channel credential.
    std::env::set_var("HERALD_ORG_API_KEY", "org-key-test-value");
    let config = oncewise_ai_sync::config::Config::from_env().expect("complete herald config");
    match &config.auth {
        oncewise_ai_sync::config::AuthMode::Herald(herald) => {
            assert_eq!(herald.org_api_key, "org-key-test-value");
        }
        oncewise_ai_sync::config::AuthMode::None => {
            panic!("complete configuration must select herald mode")
        }
    }

    // Explicit none mode wins even with every Herald variable present.
    std::env::set_var("AUTH_MODE", "none");
    assert!(matches!(
        oncewise_ai_sync::config::Config::from_env().expect("explicit none"),
        oncewise_ai_sync::config::Config {
            auth: oncewise_ai_sync::config::AuthMode::None,
            ..
        }
    ));
}

// ---------------------------------------------------------------------------
// w08 — legacy and none mode: zero change
// ---------------------------------------------------------------------------

// Covers US-WP-007: on a herald deployment the key-addressed flow keeps working byte for byte
// next to the new surface (join by key, peer read/write, BAD_SPACE_KEY distinguishable from the
// new 403 family), and the mode probe advertises workspacePermissions only when it is served.
// The full s01–s10 / a01–a09 regression is the runner's gate.
#[tokio::test]
async fn w08_key_spaces_unchanged_and_probe() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    let a = herald.login("w08-a@test.oncewise.local").await;
    let b = herald.login("w08-b@test.oncewise.local").await;

    let (status, _) = call(
        &app.app,
        "POST",
        "/api/spaces",
        Some(&a),
        Some(json!({ "id": "sp-w08-000000000001", "key": KEY_A, "name": "Legacy" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Join by key (the get_space verification) and peer writes work unchanged.
    let (status, _) = call_with_key(
        &app.app,
        "GET",
        "/api/spaces/sp-w08-000000000001",
        Some(&b),
        KEY_A,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = call_with_key(
        &app.app,
        "POST",
        "/api/spaces/sp-w08-000000000001/scripts",
        Some(&b),
        KEY_A,
        Some(script_body("sc-w08-000000000001")),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // The 401 family stays distinguishable from the new 403 family on the same deployment.
    let (status, body) = call_with_key(
        &app.app,
        "GET",
        "/api/spaces/sp-w08-000000000001",
        Some(&b),
        KEY_B,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&body), "BAD_SPACE_KEY");

    // A member-less org-bound space answers 403 with the new code.
    create_org_space(&app.app, &a, "sp-w08-000000000002").await;
    let (status, body) = call(
        &app.app,
        "GET",
        "/api/spaces/sp-w08-000000000002",
        Some(&b),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "SPACE_ACCESS_DENIED");

    // The probe: workspacePermissions is true exactly when the org channel is assembled.
    let (status, body) = call(&app.app, "GET", "/api/auth/config", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], json!(true));
    assert_eq!(body["workspacePermissions"], json!(true));
    let none_app = spawn_none().await;
    let (status, body) = call(&none_app.app, "GET", "/api/auth/config", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], json!(false));
    assert_eq!(body["workspacePermissions"], json!(false));
}
