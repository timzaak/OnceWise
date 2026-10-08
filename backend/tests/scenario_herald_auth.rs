// Scenario tests for the Herald sign-in gate (a01–a09) against a REAL Herald instance
// running in docker (scripts/test-start.py; image ghcr.io/timzaak/herald, overridable via
// HERALD_IMAGE). Realms, the BFF client app and test users are seeded as idempotent SQL
// straight into Herald's own database; outage cases stop/start the container or point at a
// dead/stalled socket. There is no HTTP double: the status / authorize / token / refresh
// contracts are exercised end to end, so any upstream drift fails these tests loudly.
//
// Environment (defaults match scripts/test-start.py):
//   TEST_HERALD_URL           Herald base URL        (http://127.0.0.1:13001)
//   TEST_HERALD_DATABASE_URL  Herald's PostgreSQL    (postgres://postgres:postgres@127.0.0.1:5432/herald_test)
//   TEST_HERALD_REDIS         Herald's Redis address (127.0.0.1:16381) — used only to clear
//                             Herald's login/authorize rate-limit keys between logins; the
//                             a07 capacity case performs >100 real logins in one burst.
// Business-endpoint cases still need TEST_DATABASE_URL / DATABASE_URL (scenario_data_sync.rs).
//
// The tests serialize on one mutex: a05 stops the shared Herald container mid-run.

mod common;

use std::io::{BufRead, BufReader, Read, Write as _};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::{HeaderMap, StatusCode};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use oncewise_ai_sync::config::{AuthMode, Config, HeraldConfig};
use oncewise_ai_sync::routes::auth::{Clock, HeraldAuth};
use oncewise_ai_sync::{routes, AppState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use common::{json_of, send, KEY_A, KEY_B};

const REALM: &str = "oncewise";
const REALM_OTHER: &str = "oncewise-other";
const CLIENT_ID: &str = "oncewise-sync";
// Seeded users reuse the image's bootstrap-admin password hash (admin realm), exactly like
// the rmqtt-things test tooling — so every test user logs in with "password".
const PASSWORD: &str = "password";
// Whitelisted in the seeded client app; nothing serves it (the code comes from the login
// JSON response, and oncewise-ai-sync only exchanges it server-to-server).
const CALLBACK_URI: &str = "http://127.0.0.1:8099/api/auth/oauth/callback";
const HERALD_CONTAINER: &str = "oncewise-test-herald";

/// Serializes the whole suite (a05 stops the shared container mid-run).
static SUITE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn herald_base_url() -> String {
    std::env::var("TEST_HERALD_URL").unwrap_or_else(|_| "http://127.0.0.1:13001".to_string())
}

fn herald_db_url() -> String {
    std::env::var("TEST_HERALD_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:5432/herald_test".to_string())
}

fn herald_redis_addr() -> String {
    std::env::var("TEST_HERALD_REDIS").unwrap_or_else(|_| "127.0.0.1:16381".to_string())
}

struct Herald {
    base: String,
    http: reqwest::Client,
    db: sqlx::PgPool,
    redis: String,
}

impl Herald {
    async fn connect() -> Self {
        let db = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&herald_db_url())
            .await
            .expect("Herald's database is not reachable; run scripts/test-start.py first");
        Self {
            base: herald_base_url(),
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("test http client"),
            db,
            redis: herald_redis_addr(),
        }
    }

    /// Idempotent seed: two realms, the BFF client app (both realms — the second backs the
    /// realm-mismatch case), one role, and the per-test users. Re-running resets account
    /// status, so a disabled account from a previous run never leaks in.
    async fn seed(&self) {
        let users: &[(&str, &str, bool)] = &[
            (REALM, "a02@test.oncewise.local", false),
            (REALM, "a03-roleful@test.oncewise.local", true),
            (REALM, "a03-plain@test.oncewise.local", false),
            (REALM, "a04@test.oncewise.local", false),
            (REALM, "a04-reader@test.oncewise.local", false),
            (REALM, "a05@test.oncewise.local", false),
            (REALM, "a06@test.oncewise.local", false),
            (REALM, "a06b@test.oncewise.local", false),
            (REALM, "a07@test.oncewise.local", false),
            (REALM, "a08@test.oncewise.local", false),
            (REALM_OTHER, "a04-other@test.oncewise.local", false),
        ];
        let mut user_sql = String::new();
        for (realm, email, with_role) in users {
            user_sql.push_str(&format!(
                "\nINSERT INTO account (id, realm_id, email, password, status)\
                 \nVALUES (uuidv7(), '{realm}', '{email}', v_hash, 1)\
                 \nON CONFLICT (realm_id, email) DO UPDATE SET status = 1;\
                 \nSELECT id INTO v_user FROM account WHERE realm_id = '{realm}' AND email = '{email}';\
                 \nINSERT INTO profile (id, realm_id, nickname) VALUES (v_user, '{realm}', 'Test User')\
                 \nON CONFLICT (id, realm_id) DO NOTHING;\
                 \nINSERT INTO user_agreement_consent (id, user_id, realm_id, agreement_type, consented_version_id)\
                 \nSELECT uuidv7(), v_user, '{realm}', v.agreement_type, v.id FROM legal_agreement_version v\
                 \nWHERE v.id IN (SELECT DISTINCT ON (lv.agreement_type) lv.id FROM legal_agreement_version lv\
                 \n  WHERE (lv.realm_id IS NULL OR lv.realm_id = '{realm}')\
                 \n  ORDER BY lv.agreement_type, (lv.realm_id IS NULL), lv.version_no DESC)\
                 \nON CONFLICT (user_id, agreement_type) DO UPDATE SET\
                 \n  consented_version_id = EXCLUDED.consented_version_id, consented_at = CURRENT_TIMESTAMP;"
            ));
            if *with_role {
                user_sql.push_str(&format!(
                    "\nSELECT id INTO v_role FROM roles\
                     \nWHERE name = 'oncewise-test-role' AND realm_id = '{REALM}' AND client_id = '{CLIENT_ID}';\
                     \nINSERT INTO user_roles (id, user_id, role_id, realm_id, client_id, principal_type, principal_id, source)\
                     \nVALUES (uuidv7(), v_user, v_role, '{REALM}', '{CLIENT_ID}', 'user', v_user::text, 'manual')\
                     \nON CONFLICT (realm_id, principal_type, principal_id, role_id) WHERE source = 'manual' DO NOTHING;"
                ));
            }
        }
        let sql = format!(
            "DO $$\
             \nDECLARE v_hash text; v_user uuid; v_role uuid;\
             \nBEGIN\
             \n  SELECT password INTO v_hash FROM account WHERE realm_id = 'admin' LIMIT 1;\
             \n  INSERT INTO realm (id, name) VALUES ('{REALM}', 'OnceWise Test') ON CONFLICT (id) DO NOTHING;\
             \n  INSERT INTO realm (id, name) VALUES ('{REALM_OTHER}', 'OnceWise Other') ON CONFLICT (id) DO NOTHING;\
             \n  INSERT INTO client_app (id, realm_id, client_id, name, redirect_uris)\
             \n  VALUES (uuidv7(), '{REALM}', '{CLIENT_ID}', 'OnceWise Sync BFF', '[\"{CALLBACK_URI}\"]'::jsonb)\
             \n  ON CONFLICT (realm_id, client_id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris;\
             \n  INSERT INTO client_app (id, realm_id, client_id, name, redirect_uris)\
             \n  VALUES (uuidv7(), '{REALM_OTHER}', '{CLIENT_ID}', 'OnceWise Sync BFF', '[\"{CALLBACK_URI}\"]'::jsonb)\
             \n  ON CONFLICT (realm_id, client_id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris;\
             \n  INSERT INTO roles (id, name, description, realm_id, client_id, is_builtin)\
             \n  VALUES (uuidv7(), 'oncewise-test-role', 'herald-support test role', '{REALM}', '{CLIENT_ID}', true)\
             \n  ON CONFLICT (name, realm_id, client_id) DO NOTHING;\
             \n{user_sql}\
             \nEND $$;"
        );
        sqlx::raw_sql(&sql)
            .execute(&self.db)
            .await
            .expect("Herald seed failed (is the image schema at the expected version?)");
    }

    /// Plain password login → real (accessToken, refreshToken). Clears Herald's rate-limit
    /// keys first: the suite performs more logins than the per-IP/per-identifier windows allow.
    async fn login(&self, realm: &str, email: &str) -> (String, String) {
        self.clear_rate_limits();
        let response = self
            .http
            .post(format!("{}/api/auth/{realm}/login", self.base))
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
        (
            value["accessToken"]
                .as_str()
                .expect("accessToken")
                .to_string(),
            value["refreshToken"]
                .as_str()
                .expect("refreshToken")
                .to_string(),
        )
    }

    /// Drives the REAL authorization flow without a browser: hit authorize (which validates
    /// client/redirect/PKCE and stores the state), then log in with the OAuth fields — Herald
    /// mints the code and answers with `redirectTo`, exactly what its login page does.
    /// `authorize_url` is the Location our /api/auth/oauth/start produced.
    async fn oauth_code(&self, realm: &str, email: &str, authorize_url: &str) -> (String, String) {
        self.clear_rate_limits();
        let response = self
            .http
            .get(authorize_url)
            .send()
            .await
            .expect("Herald authorize request failed");
        assert_eq!(
            response.status().as_u16(),
            302,
            "Herald authorize did not redirect to the login page: {}",
            response.text().await.unwrap_or_default()
        );
        let state = query_param_of(authorize_url, "state").expect("state in authorize url");
        let redirect = urlencoding::decode(
            &query_param_of(authorize_url, "redirect_uri").expect("redirect_uri"),
        )
        .expect("decode redirect_uri")
        .to_string();

        self.clear_rate_limits();
        let response = self
            .http
            .post(format!("{}/api/auth/{realm}/login", self.base))
            .json(&json!({
                "email": email,
                "password": PASSWORD,
                "clientId": CLIENT_ID,
                "oauthClientId": CLIENT_ID,
                "redirectUri": redirect,
                "state": state,
            }))
            .send()
            .await
            .expect("Herald login request failed");
        let body = response.text().await.expect("login body");
        let value: Value = serde_json::from_str(&body)
            .unwrap_or_else(|_| panic!("Herald login response was not JSON: {body}"));
        assert!(
            value.get("requiresTotp").and_then(Value::as_bool) != Some(true)
                && value.get("consentRequired").and_then(Value::as_bool) != Some(true),
            "Herald login needs interaction (TOTP/consent) for {email}: {body}"
        );
        let redirect_to = value["redirectTo"]
            .as_str()
            .expect("redirectTo in login response");
        let code = query_param_of(redirect_to, "code").expect("code in redirectTo");
        let echoed = query_param_of(redirect_to, "state").expect("state in redirectTo");
        assert_eq!(echoed, state, "Herald must echo our state");
        (code, state)
    }

    async fn set_account_status(&self, realm: &str, email: &str, status: i32) {
        sqlx::query("UPDATE account SET status = $1 WHERE realm_id = $2 AND email = $3")
            .bind(status)
            .bind(realm)
            .bind(email)
            .execute(&self.db)
            .await
            .expect("account status update");
    }

    /// Deletes Herald's rl:* keys so login/authorize/token bursts (a07 does >100) do not trip
    /// the per-IP/per-identifier windows. Minimal inline RESP client — no test dependency.
    fn clear_rate_limits(&self) {
        let Ok(mut stream) = std::net::TcpStream::connect(&self.redis) else {
            return; // best-effort: the rate limits then simply apply
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        // One BufReader for the whole exchange: a fresh BufReader per line would swallow the
        // rest of the reply into its buffer and drop those bytes with it.
        let mut reader = BufReader::new(&mut stream);
        if reader
            .get_mut()
            .write_all(b"*2\r\n$4\r\nKEYS\r\n$4\r\nrl:*\r\n")
            .is_err()
        {
            return;
        }
        let keys = read_resp_bulk_strings(&mut reader);
        if keys.is_empty() {
            return;
        }
        let mut command = format!("*{}\r\n$3\r\nDEL\r\n", keys.len() + 1);
        for key in &keys {
            command.push_str(&format!("${}\r\n{key}\r\n", key.len()));
        }
        let _ = reader.get_mut().write_all(command.as_bytes());
        let _ = read_resp_line(&mut reader);
    }

    async fn stop_container(&self) {
        docker_output(["stop", HERALD_CONTAINER], "stop the Herald container");
    }

    async fn start_container_and_wait(&self) {
        docker_output(["start", HERALD_CONTAINER], "start the Herald container");
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            if let Ok(response) = self.http.get(format!("{}/health", self.base)).send().await {
                if response.status().is_success() {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        panic!("Herald did not come back healthy within 120s after docker start");
    }
}

fn docker_output(args: [&str; 2], what: &str) {
    let output = std::process::Command::new("docker")
        .args(args)
        .output()
        .unwrap_or_else(|err| panic!("failed to run docker ({what}): {err}"));
    assert!(
        output.status.success(),
        "docker {args:?} failed ({what}): {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn read_resp_line(reader: &mut BufReader<&mut std::net::TcpStream>) -> Option<String> {
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    Some(line.trim_end().to_string())
}

/// Parses a RESP array of bulk strings (the reply shape of KEYS).
fn read_resp_bulk_strings(reader: &mut BufReader<&mut std::net::TcpStream>) -> Vec<String> {
    let Some(header) = read_resp_line(reader) else {
        return Vec::new();
    };
    let Some(count) = header
        .strip_prefix('*')
        .and_then(|n| n.parse::<usize>().ok())
    else {
        return Vec::new();
    };
    let mut keys = Vec::with_capacity(count);
    for _ in 0..count {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() {
            break;
        }
        let Some(len) = header
            .trim_end()
            .strip_prefix('$')
            .and_then(|n| n.parse::<usize>().ok())
        else {
            break;
        };
        let mut bytes = vec![0u8; len];
        if reader.read_exact(&mut bytes).is_err() {
            break;
        }
        let mut crlf = [0u8; 2];
        let _ = reader.read_exact(&mut crlf);
        keys.push(String::from_utf8_lossy(&bytes).to_string());
    }
    keys
}

/// A TCP server that accepts connections and never answers — a real stalled upstream for the
/// 10 s budget case (no double involved, just a socket that holds the connection open).
fn stalled_socket_base() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stalled socket");
    let addr = listener.local_addr().expect("stalled socket addr");
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming().flatten() {
            held.push(stream);
        }
    });
    format!("http://{addr}")
}

type Offset = Arc<Mutex<Duration>>;

fn final_uri() -> String {
    "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/".to_string()
}

fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Deterministic extension-side proof material: verifier (43 base64url chars) + its S256
/// digest, mirroring what the extension keeps in memory during a login.
fn extension_proof(seed: u64) -> (String, String) {
    let verifier = b64url(&Sha256::digest(seed.to_le_bytes()));
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn test_clock() -> (Offset, Clock) {
    let offset: Offset = Arc::default();
    let advanced = offset.clone();
    let base = Instant::now();
    let clock: Clock = Arc::new(move || base + *advanced.lock().unwrap());
    (offset, clock)
}

fn herald_config(base_url: &str) -> HeraldConfig {
    HeraldConfig::new(base_url, REALM, CLIENT_ID, CALLBACK_URI)
        .expect("test Herald config must be valid (loopback http is allowed)")
}

struct TestApp {
    app: Router,
    offset: Offset,
}

async fn spawn_herald(base_url: &str) -> TestApp {
    let pool = common::migrated_pool().await;
    let (offset, clock) = test_clock();
    let herald = HeraldAuth::with_clock(herald_config(base_url), clock).expect("herald assembly");
    TestApp {
        app: routes::build_router(AppState {
            pool,
            auth: Some(herald),
        }),
        offset,
    }
}

async fn spawn_none() -> TestApp {
    TestApp {
        app: routes::build_router(AppState {
            pool: common::migrated_pool().await,
            auth: None,
        }),
        offset: Arc::default(),
    }
}

fn advance(app: &TestApp, by: Duration) {
    *app.offset.lock().unwrap() += by;
}

fn error_code(body: &Value) -> String {
    body["error"]["code"]
        .as_str()
        .unwrap_or("<missing code>")
        .to_string()
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<missing>")
}

/// The name=value pair of a Set-Cookie header (attributes stripped).
fn cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap_or("").to_string()
}

fn query_param_of(url: &str, key: &str) -> Option<String> {
    url.split_once('?')?.1.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

async fn create_space_ok(app: &TestApp, bearer: &str, space_id: &str) {
    let (status, _, body) = send(
        &app.app,
        "POST",
        "/api/spaces",
        &[("authorization", bearer)],
        Some(json!({ "id": space_id, "key": KEY_A, "name": "Team Space" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "space creation failed: {}",
        String::from_utf8_lossy(&body)
    );
}

async fn start_login(app: &TestApp, challenge: &str) -> (String, String) {
    let uri = format!(
        "/api/auth/oauth/start?finalUri={}&handoffChallenge={}",
        urlencoding::encode(&final_uri()),
        urlencoding::encode(challenge)
    );
    let (status, headers, body) = send(&app.app, "GET", &uri, &[], None).await;
    assert_eq!(
        status,
        StatusCode::FOUND,
        "oauth/start failed: {}",
        String::from_utf8_lossy(&body)
    );
    let location = header_str(&headers, "location").to_string();
    let set_cookie = headers
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .expect("oauth/start must set the transaction cookie")
        .to_string();
    (location, set_cookie)
}

async fn callback(
    app: &TestApp,
    cookie_pair: &str,
    query: &str,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    send(
        &app.app,
        "GET",
        &format!("/api/auth/oauth/callback?{query}"),
        &[("cookie", cookie_pair)],
        None,
    )
    .await
}

async fn redeem(app: &TestApp, code: &str, verifier: &str) -> (StatusCode, HeaderMap, Value) {
    let (status, headers, body) = send(
        &app.app,
        "POST",
        "/api/auth/redeem",
        &[],
        Some(json!({ "handoffCode": code, "handoffVerifier": verifier })),
    )
    .await;
    (status, headers, json_of(&body))
}

/// The complete real BFF login against dockerized Herald: our start → real authorize → real
/// password login with OAuth fields → our callback (real PKCE token exchange) → the handoff
/// code paired with the verifier that redeems it.
async fn bff_login(herald: &Herald, app: &TestApp, email: &str, seed: u64) -> (String, String) {
    let (verifier, challenge) = extension_proof(seed);
    let (location, set_cookie) = start_login(app, &challenge).await;
    let (code, state) = herald.oauth_code(REALM, email, &location).await;
    // The token exchange our callback performs is rate-limited per IP too (30/60s) — with
    // >100 logins in this suite the keys must be cleared ahead of each exchange.
    herald.clear_rate_limits();
    let (status, headers, body) = callback(
        app,
        &cookie_pair(&set_cookie),
        &format!("code={code}&state={state}"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FOUND,
        "oauth/callback failed: {}",
        String::from_utf8_lossy(&body)
    );
    let handoff = header_str(&headers, "location")
        .rsplit_once("#handoffCode=")
        .expect("handoffCode fragment")
        .1
        .to_string();
    (handoff, verifier)
}

#[tokio::test]
async fn a01_mode_probe_and_none_routing() {
    let _suite = SUITE.lock().await;
    // herald mode: the probe advertises the gate and the login entry point.
    let app = spawn_herald(&herald_base_url()).await;
    let (status, _, body) = send(&app.app, "GET", "/api/auth/config", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    let body = json_of(&body);
    assert_eq!(body["enabled"], json!(true));
    assert_eq!(body["loginUrl"], json!("/api/auth/oauth/start"));

    // none mode: disabled probe, the other four auth endpoints are absent (404), and the
    // public ops endpoints need no Bearer in either mode.
    let none_app = spawn_none().await;
    let (status, _, body) = send(&none_app.app, "GET", "/api/auth/config", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    let body = json_of(&body);
    assert_eq!(body["enabled"], json!(false));
    assert_eq!(body["loginUrl"], Value::Null);
    for (method, uri) in [
        ("GET", "/api/auth/oauth/start?finalUri=x&handoffChallenge=y"),
        ("GET", "/api/auth/oauth/callback"),
        ("POST", "/api/auth/redeem"),
        ("POST", "/api/auth/refresh"),
    ] {
        let (status, _, body) = send(&none_app.app, method, uri, &[], None).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "{uri} must be absent in none mode"
        );
        assert_eq!(error_code(&json_of(&body)), "NOT_FOUND");
    }
    for uri in ["/api/health", "/api/openapi.json"] {
        let (status, _, _) = send(&none_app.app, "GET", uri, &[], None).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{uri} must stay public without a Bearer"
        );
        let (status, _, _) = send(&app.app, "GET", uri, &[], None).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{uri} must stay public in herald mode too"
        );
    }
}

#[tokio::test]
async fn a02_unsigned_requests_rejected_before_business() {
    let _suite = SUITE.lock().await;
    let app = spawn_herald(&herald_base_url()).await;

    let space = "sp-a02-000000000001";
    let script = "sc-a02-000000000001";
    let cases: [(&str, String, Option<Value>); 9] = [
        (
            "POST",
            "/api/spaces".into(),
            Some(json!({"id": space, "key": KEY_A, "name": "T"})),
        ),
        ("GET", format!("/api/spaces/{space}"), None),
        ("DELETE", format!("/api/spaces/{space}"), None),
        (
            "POST",
            format!("/api/spaces/{space}/scripts"),
            Some(json!({"id": script, "name": "S", "flowContent": {}})),
        ),
        ("GET", format!("/api/spaces/{space}/scripts"), None),
        (
            "PATCH",
            format!("/api/spaces/{space}/scripts/{script}"),
            Some(json!({"name": "S2"})),
        ),
        (
            "POST",
            format!("/api/spaces/{space}/scripts/{script}/versions"),
            Some(json!({"flowContent": {}})),
        ),
        (
            "GET",
            format!("/api/spaces/{space}/scripts/{script}/versions"),
            None,
        ),
        (
            "GET",
            format!("/api/spaces/{space}/scripts/{script}/versions/1"),
            None,
        ),
    ];
    for (method, uri, body) in &cases {
        // Missing header, wrong scheme, and an empty token are all plain "not signed in" —
        // and none of them may reach Herald (the gate answers 401 locally).
        for auth in [
            None,
            Some("Basic dXNlcjpwYXNz"),
            Some("Bearer "),
            Some("InvalidBearer x"),
        ] {
            let headers: Vec<(&str, &str)> =
                auth.map(|a| vec![("authorization", a)]).unwrap_or_default();
            let (status, _, body_out) = send(&app.app, method, uri, &headers, body.clone()).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{method} {uri} with {auth:?}"
            );
            assert_eq!(error_code(&json_of(&body_out)), "AUTH_REQUIRED");
        }
    }

    // With a real sign-in the 401 family stays distinguishable: a wrong space key is
    // BAD_SPACE_KEY, not AUTH_REQUIRED.
    let herald = Herald::connect().await;
    herald.seed().await;
    let (access, _refresh) = herald.login(REALM, "a02@test.oncewise.local").await;
    let bearer = format!("Bearer {access}");
    create_space_ok(&app, &bearer, space).await;
    let (status, _, body) = send(
        &app.app,
        "GET",
        &format!("/api/spaces/{space}"),
        &[("authorization", bearer.as_str()), ("x-space-key", KEY_B)],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&json_of(&body)), "BAD_SPACE_KEY");
}

#[tokio::test]
async fn a03_valid_login_suffices_business_unchanged() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    // A user carrying a role and a user with no role at all enjoy identical business access:
    // the gate only asks "validly signed in for this realm".
    for (email, space_index) in [
        ("a03-roleful@test.oncewise.local", 0u8),
        ("a03-plain@test.oncewise.local", 1),
    ] {
        let (access, _) = herald.login(REALM, email).await;
        let bearer = format!("Bearer {access}");
        let space = format!("sp-a03-{space_index:012}");
        let script = format!("sc-a03-{space_index:012}");
        create_space_ok(&app, &bearer, &space).await;

        let (status, _, _) = send(
            &app.app,
            "POST",
            &format!("/api/spaces/{space}/scripts"),
            &[("authorization", bearer.as_str()), ("x-space-key", KEY_A)],
            Some(json!({ "id": script, "name": "F", "flowContent": {"v": 1} })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "script create failed for {email}"
        );

        let (status, _, _) = send(
            &app.app,
            "POST",
            &format!("/api/spaces/{space}/scripts/{script}/versions"),
            &[("authorization", bearer.as_str()), ("x-space-key", KEY_A)],
            Some(json!({ "versionNote": "v2", "flowContent": {"v": 2} })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "version append failed for {email}"
        );

        let (status, _, body) = send(
            &app.app,
            "GET",
            &format!("/api/spaces/{space}/scripts/{script}/versions"),
            &[("authorization", bearer.as_str()), ("x-space-key", KEY_A)],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let versions = json_of(&body);
        assert_eq!(
            versions.as_array().map(|v| v.len()),
            Some(2),
            "versions for {email}"
        );

        // The second layer is untouched: a wrong key is still BAD_SPACE_KEY for every user.
        let (status, _, body) = send(
            &app.app,
            "GET",
            &format!("/api/spaces/{space}"),
            &[("authorization", bearer.as_str()), ("x-space-key", KEY_B)],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(error_code(&json_of(&body)), "BAD_SPACE_KEY");
    }
}

#[tokio::test]
async fn a04_identity_expiry_and_realm_boundary() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    // Sequence with one real user: success first, then the account is disabled in Herald —
    // the very next request is rejected and no business write happens.
    let email = "a04@test.oncewise.local";
    let (access, _) = herald.login(REALM, email).await;
    let bearer = format!("Bearer {access}");
    let space = "sp-a04-000000000001";
    let script = "sc-a04-000000000001";
    create_space_ok(&app, &bearer, space).await;

    // Herald's UserStatus: 1 = Normal, 2 = Forbidden (disabled — identity middleware
    // rejects the token on the very next request; WaitVerified=0 still authenticates).
    herald.set_account_status(REALM, email, 2).await;
    let (status, _, body) = send(
        &app.app,
        "POST",
        &format!("/api/spaces/{space}/scripts"),
        &[("authorization", bearer.as_str()), ("x-space-key", KEY_A)],
        Some(json!({ "id": script, "name": "F", "flowContent": {} })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "disabled account must be rejected"
    );
    assert_eq!(error_code(&json_of(&body)), "AUTH_REQUIRED");

    // A still-valid reader proves the disabled writer performed no business write.
    let (reader, _) = herald.login(REALM, "a04-reader@test.oncewise.local").await;
    let (status, _, body) = send(
        &app.app,
        "GET",
        &format!("/api/spaces/{space}/scripts"),
        &[
            ("authorization", format!("Bearer {reader}").as_str()),
            ("x-space-key", KEY_A),
        ],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json_of(&body).as_array().map(|v| v.len()),
        Some(0),
        "no business write may happen"
    );

    // Realm boundary: a valid token issued by a DIFFERENT realm is a deployment mismatch —
    // 503 with the realm-check hint, never a silent allow and never "please re-sign-in".
    let (other_access, _) = herald
        .login(REALM_OTHER, "a04-other@test.oncewise.local")
        .await;
    let (status, _, body) = send(
        &app.app,
        "POST",
        "/api/spaces",
        &[("authorization", format!("Bearer {other_access}").as_str())],
        Some(json!({ "id": "sp-a04-other-000001", "key": KEY_A, "name": "T" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "cross-realm token must fail closed"
    );
    assert_eq!(error_code(&json_of(&body)), "AUTH_UNAVAILABLE");
}

#[tokio::test]
async fn a05_outage_fail_closed_then_recovery() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    let (access, _) = herald.login(REALM, "a05@test.oncewise.local").await;
    let bearer = format!("Bearer {access}");
    let space = "sp-a05-000000000001";
    let script = "sc-a05-000000000001";
    create_space_ok(&app, &bearer, space).await;
    let (status, _, _) = send(
        &app.app,
        "POST",
        &format!("/api/spaces/{space}/scripts"),
        &[("authorization", bearer.as_str()), ("x-space-key", KEY_A)],
        Some(json!({ "id": script, "name": "F", "flowContent": {} })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Herald down (real container stop): every business request fails closed and no write
    // happens, while the public endpoints never depend on the provider.
    herald.stop_container().await;
    for uri in ["/api/health", "/api/auth/config"] {
        let (status, _, _) = send(&app.app, "GET", uri, &[], None).await;
        assert_eq!(status, StatusCode::OK, "{uri} must not depend on Herald");
    }
    let (status, _, body) = send(
        &app.app,
        "POST",
        &format!("/api/spaces/{space}/scripts/{script}/versions"),
        &[("authorization", bearer.as_str()), ("x-space-key", KEY_A)],
        Some(json!({ "flowContent": {"v": 2} })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "provider outage");
    assert_eq!(error_code(&json_of(&body)), "AUTH_UNAVAILABLE");
    let (status, _, _) = send(
        &app.app,
        "GET",
        &format!("/api/spaces/{space}/scripts/{script}/versions"),
        &[("authorization", bearer.as_str()), ("x-space-key", KEY_A)],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // Recovery: the SAME token keeps working once Herald is back — no re-login, and the
    // version that failed during the outage was never written.
    herald.start_container_and_wait().await;
    let (status, _, _) = send(
        &app.app,
        "POST",
        &format!("/api/spaces/{space}/scripts/{script}/versions"),
        &[("authorization", bearer.as_str()), ("x-space-key", KEY_A)],
        Some(json!({ "flowContent": {"v": 3} })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "recovery must not require a new sign-in"
    );
    let (status, _, body) = send(
        &app.app,
        "GET",
        &format!("/api/spaces/{space}/scripts/{script}/versions"),
        &[("authorization", bearer.as_str()), ("x-space-key", KEY_A)],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_of(&body).as_array().map(|v| v.len()), Some(2));

    // A stalled upstream (accepts the connection, never answers) must respect the 10 s
    // budget — a real socket, not a double. This case costs ~10 s.
    let stalled_app = spawn_herald(&stalled_socket_base()).await;
    let started = Instant::now();
    let (status, _, body) = send(
        &stalled_app.app,
        "GET",
        "/api/spaces",
        &[("authorization", "Bearer anything")],
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "stalled provider must fail closed"
    );
    assert_eq!(error_code(&json_of(&body)), "AUTH_UNAVAILABLE");
    assert!(
        started.elapsed() < Duration::from_secs(13),
        "must respect the 10s budget"
    );
}

#[tokio::test]
async fn a06_oauth_handoff_roundtrip() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;
    let email = "a06@test.oncewise.local";

    let (verifier, challenge) = extension_proof(1);
    let (location, set_cookie) = start_login(&app, &challenge).await;

    // The authorize redirect targets the real Herald path with our exact parameters.
    let authorize_prefix = format!("{}/api/oauth/{REALM}/authorize?", herald.base);
    assert!(
        location.starts_with(&authorize_prefix),
        "unexpected authorize target: {location}"
    );
    assert_eq!(
        query_param_of(&location, "client_id").as_deref(),
        Some(CLIENT_ID)
    );
    assert_eq!(
        query_param_of(&location, "response_type").as_deref(),
        Some("code")
    );
    assert_eq!(
        query_param_of(&location, "code_challenge_method").as_deref(),
        Some("S256")
    );
    assert_eq!(
        query_param_of(&location, "redirect_uri")
            .and_then(|v| urlencoding::decode(&v).ok().map(|s| s.to_string()))
            .as_deref(),
        Some(CALLBACK_URI)
    );
    let challenge_param = query_param_of(&location, "code_challenge").expect("code_challenge");
    assert_eq!(challenge_param.len(), 43);
    let state = query_param_of(&location, "state").expect("state");
    assert_eq!(state.len(), 64);

    // Loopback deployment → plain cookie name, no Secure, but HttpOnly + Lax + bounded age.
    assert!(
        set_cookie.starts_with("OW_SYNC_OAUTH="),
        "cookie name: {set_cookie}"
    );
    assert!(set_cookie.contains("Path=/"));
    assert!(set_cookie.contains("Max-Age=300"));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Lax"));
    assert!(!set_cookie.contains("Secure"));

    // Real code from the real authorize + login endpoints, then OUR callback performs the
    // real PKCE token exchange and hands back only the handoff code.
    let (code, _) = herald.oauth_code(REALM, email, &location).await;
    let (status, headers, _) = callback(
        &app,
        &cookie_pair(&set_cookie),
        &format!("code={code}&state={state}"),
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    let redirect = header_str(&headers, "location").to_string();
    let handoff = redirect
        .strip_prefix(&format!("{}#handoffCode=", final_uri()))
        .expect("redirect must target the validated finalUri with a handoff fragment")
        .to_string();
    assert_eq!(handoff.len(), 43);
    assert_eq!(header_str(&headers, "cache-control"), "no-store");
    assert!(
        header_str(&headers, "set-cookie").contains("Max-Age=0"),
        "cookie must be cleared"
    );

    let (status, headers, body) = redeem(&app, &handoff, &verifier).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tokenType"], json!("Bearer"));
    let access = body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string();
    let refresh = body["refreshToken"]
        .as_str()
        .expect("refreshToken")
        .to_string();
    assert!(!access.is_empty() && !refresh.is_empty());
    let ttl_now = body["expiresIn"].as_i64().expect("expiresIn");
    assert!(
        (1..=900).contains(&ttl_now),
        "Herald access TTL is ~900s, got {ttl_now}"
    );
    assert_eq!(header_str(&headers, "cache-control"), "no-store");
    // The real tokens never appeared in any URL along the way.
    assert!(!redirect.contains(&access) && !redirect.contains(&refresh));

    // Expiry counts from issuance: a second login redeemed 10 s later reports a strictly
    // smaller remaining TTL instead of resetting it.
    let (handoff_b, verifier_b) = bff_login(&herald, &app, "a06b@test.oncewise.local", 11).await;
    advance(&app, Duration::from_secs(10));
    let (status, _, body) = redeem(&app, &handoff_b, &verifier_b).await;
    assert_eq!(status, StatusCode::OK);
    let ttl_later = body["expiresIn"].as_i64().expect("expiresIn");
    assert!(
        ttl_later < ttl_now,
        "TTL must decrease ({ttl_later} !< {ttl_now})"
    );

    // Exactly one redemption per handoff code.
    let (status, _, body) = redeem(&app, &handoff_b, &verifier_b).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "INVALID_INPUT");
}

#[tokio::test]
async fn a07_oauth_trust_replay_and_bounds() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;
    let email = "a07@test.oncewise.local";

    // --- cookies that were never issued (or were tampered with) never steer a redirect.
    for cookie in [
        format!("OW_SYNC_OAUTH={}", "a".repeat(64)),
        "OW_SYNC_OAUTH=abc".to_string(),
        "garbage-without-equals".to_string(),
    ] {
        let (status, headers, body) = callback(&app, &cookie, "code=c&state=s").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "cookie {cookie}");
        assert_eq!(error_code(&json_of(&body)), "INVALID_INPUT");
        assert!(
            header_str(&headers, "set-cookie").contains("Max-Age=0"),
            "cookie must be cleared on reject"
        );
    }
    // No cookie header at all → same rejection.
    let (status, _, body) = send(
        &app.app,
        "GET",
        "/api/auth/oauth/callback?code=c&state=s",
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&json_of(&body)), "INVALID_INPUT");

    // --- a wrong state still only ever redirects to the transaction's validated finalUri,
    //     and consuming the transaction means replaying the correct state now answers 400.
    let (_verifier, challenge) = extension_proof(2);
    let (location, set_cookie) = start_login(&app, &challenge).await;
    let state = query_param_of(&location, "state").expect("state");
    let (status, headers, _) = callback(
        &app,
        &cookie_pair(&set_cookie),
        &format!("code=ac_forged&state={}", "f".repeat(64)),
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    let redirect = header_str(&headers, "location").to_string();
    assert!(
        redirect.starts_with(&format!("{}#error=state_mismatch", final_uri())),
        "wrong state must redirect to the validated finalUri: {redirect}"
    );
    let (status, _, _) = callback(
        &app,
        &cookie_pair(&set_cookie),
        &format!("code=ac_forged&state={state}"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a spent transaction cannot be replayed"
    );

    // --- unexpected callback parameters are rejected before anything is consumed.
    let (_verifier3, challenge3) = extension_proof(3);
    let (location3, set_cookie3) = start_login(&app, &challenge3).await;
    let state3 = query_param_of(&location3, "state").expect("state");
    let (status, _, body) = callback(
        &app,
        &cookie_pair(&set_cookie3),
        &format!("code=ac-x&state={state3}&foo=1"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&json_of(&body)), "INVALID_INPUT");

    // --- a malformed landing page is rejected at start: no transaction, no cookie.
    for bad in [
        "http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/".to_string(),
        "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org:8443/".to_string(),
        "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback".to_string(),
        "https://chromiumapp.org.evil.example/".to_string(),
    ] {
        let uri = format!(
            "/api/auth/oauth/start?finalUri={}&handoffChallenge={}",
            urlencoding::encode(&bad),
            urlencoding::encode(&challenge3)
        );
        let (status, headers, body) = send(&app.app, "GET", &uri, &[], None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "finalUri {bad}");
        assert_eq!(error_code(&json_of(&body)), "INVALID_INPUT");
        assert!(
            headers.get("set-cookie").is_none(),
            "no cookie for a rejected start"
        );
    }
    // A malformed challenge is rejected too.
    let short_challenge: String = challenge3.chars().take(42).collect();
    let uri = format!(
        "/api/auth/oauth/start?finalUri={}&handoffChallenge={}",
        urlencoding::encode(&final_uri()),
        urlencoding::encode(&short_challenge)
    );
    let (status, _, body) = send(&app.app, "GET", &uri, &[], None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&json_of(&body)), "INVALID_INPUT");

    // --- forged Host / forwarding headers cannot move redirect_uri.
    let (_v4, challenge4) = extension_proof(4);
    let uri = format!(
        "/api/auth/oauth/start?finalUri={}&handoffChallenge={}",
        urlencoding::encode(&final_uri()),
        urlencoding::encode(&challenge4)
    );
    let (status, headers, body) = send(
        &app.app,
        "GET",
        &uri,
        &[
            ("host", "evil.example"),
            ("x-forwarded-host", "evil.example"),
            ("x-forwarded-proto", "https"),
        ],
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FOUND,
        "{}",
        String::from_utf8_lossy(&body)
    );
    let redirect = header_str(&headers, "location").to_string();
    let redirect_param = query_param_of(&redirect, "redirect_uri").expect("redirect_uri");
    assert_eq!(
        urlencoding::decode(&redirect_param).unwrap(),
        CALLBACK_URI,
        "forged Host headers must not move redirect_uri"
    );

    // --- concurrency: exactly one exchange per transaction against the real token endpoint.
    {
        let (_verifier5, challenge5) = extension_proof(5);
        let (location5, set_cookie5) = start_login(&app, &challenge5).await;
        let (code, state) = herald.oauth_code(REALM, email, &location5).await;
        let cookie = cookie_pair(&set_cookie5);
        let query = format!("code={code}&state={state}");
        let (a, b) = tokio::join!(
            callback(&app, &cookie, &query),
            callback(&app, &cookie, &query)
        );
        let outcomes = [a.0, b.0];
        assert_eq!(
            outcomes.iter().filter(|s| **s == StatusCode::FOUND).count(),
            1,
            "exactly one concurrent exchange may succeed"
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|s| **s == StatusCode::BAD_REQUEST)
                .count(),
            1
        );
    }

    // --- transaction capacity: 128 pending logins, the 129th is politely unavailable,
    //     and expiry sweeping recovers the slots without a restart (no Herald involved).
    //     Fresh app: earlier cases intentionally left unconsumed transactions behind.
    let cap_app = spawn_herald(&herald_base_url()).await;
    for seed in 0..128u64 {
        let (_v, challenge) = extension_proof(1000 + seed);
        let uri = format!(
            "/api/auth/oauth/start?finalUri={}&handoffChallenge={}",
            urlencoding::encode(&final_uri()),
            urlencoding::encode(&challenge)
        );
        let (status, _, body) = send(&cap_app.app, "GET", &uri, &[], None).await;
        assert_eq!(
            status,
            StatusCode::FOUND,
            "seed {seed}: {}",
            String::from_utf8_lossy(&body)
        );
    }
    let (_v, challenge) = extension_proof(2000);
    let uri = format!(
        "/api/auth/oauth/start?finalUri={}&handoffChallenge={}",
        urlencoding::encode(&final_uri()),
        urlencoding::encode(&challenge)
    );
    let (status, _, body) = send(&cap_app.app, "GET", &uri, &[], None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&json_of(&body)), "AUTH_UNAVAILABLE");
    advance(&cap_app, Duration::from_secs(301));
    let (status, _, _) = send(&cap_app.app, "GET", &uri, &[], None).await;
    assert_eq!(
        status,
        StatusCode::FOUND,
        "expired transactions must be swept"
    );

    // --- handoff capacity and expiry with real logins (rate limits are cleared per login).
    //     Fresh app: the concurrency case above left one deliberately unredeemed handoff.
    let hcap_app = spawn_herald(&herald_base_url()).await;
    for seed in 0..128u64 {
        bff_login(&herald, &hcap_app, email, 3000 + seed).await;
    }
    let (_verifier_c, challenge_c) = extension_proof(4000);
    let (location_c, set_cookie_c) = start_login(&hcap_app, &challenge_c).await;
    let (code_c, state_c) = herald.oauth_code(REALM, email, &location_c).await;
    herald.clear_rate_limits();
    let (status, headers, _) = callback(
        &hcap_app,
        &cookie_pair(&set_cookie_c),
        &format!("code={code_c}&state={state_c}"),
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    let redirect = header_str(&headers, "location").to_string();
    assert!(
        redirect.starts_with(&format!("{}#error=auth_unavailable", final_uri())),
        "full handoff storage must not deliver tokens: {redirect}"
    );
    advance(&hcap_app, Duration::from_secs(61));
    let (handoff, verifier) = bff_login(&herald, &hcap_app, email, 4001).await;

    // --- expiry: a handoff older than 60 s is dead.
    advance(&hcap_app, Duration::from_secs(61));
    let (status, _, body) = redeem(&hcap_app, &handoff, &verifier).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "INVALID_INPUT");

    // --- a wrong proof does not burn the handoff; the right one still redeems it.
    let (handoff_d, right_verifier) = bff_login(&herald, &hcap_app, email, 5000).await;
    let wrong_verifier = extension_proof(5001).0;
    let (status, _, body) = redeem(&hcap_app, &handoff_d, &wrong_verifier).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "INVALID_INPUT");
    let (status, _, body) = redeem(&hcap_app, &handoff_d, &right_verifier).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a wrong proof must not consume the handoff"
    );
    assert!(!body["accessToken"].as_str().unwrap_or("").is_empty());

    // --- nothing secret ever reaches the captured log output.
    {
        struct LogSink(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for LogSink {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        struct SinkMaker(Arc<Mutex<Vec<u8>>>);
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SinkMaker {
            type Writer = LogSink;
            fn make_writer(&'a self) -> Self::Writer {
                LogSink(self.0.clone())
            }
        }
        let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(SinkMaker(captured.clone()))
            .finish();
        // current-thread test runtime: the thread-local default subscriber holds across awaits
        let _guard = tracing::subscriber::set_default(subscriber);

        let (handoff, verifier) = bff_login(&herald, &app, email, 6000).await;
        let (status, _, body) = redeem(&app, &handoff, &verifier).await;
        assert_eq!(status, StatusCode::OK);
        let access = body["accessToken"]
            .as_str()
            .expect("accessToken")
            .to_string();
        let refresh = body["refreshToken"]
            .as_str()
            .expect("refreshToken")
            .to_string();
        drop(_guard);

        let logs = String::from_utf8_lossy(&captured.lock().unwrap()).to_string();
        for secret in [&access, &refresh, &handoff, &verifier] {
            assert!(
                !logs.contains(secret.as_str()),
                "secret material reached the logs"
            );
        }
    }
}

#[tokio::test]
async fn a08_refresh_proxy_rotation_mapping() {
    let _suite = SUITE.lock().await;
    let herald = Herald::connect().await;
    herald.seed().await;
    let app = spawn_herald(&herald_base_url()).await;

    // A real token family: the proxy returns the rotated pair (fresh tokens, Bearer type,
    // positive TTLs, no-store) in the five-field shape the extension consumes.
    let (access, refresh) = herald.login(REALM, "a08@test.oncewise.local").await;
    let (status, headers, body) = send(
        &app.app,
        "POST",
        "/api/auth/refresh",
        &[],
        Some(json!({ "refreshToken": refresh })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let body = json_of(&body);
    assert_eq!(body["tokenType"], json!("Bearer"));
    let new_access = body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string();
    let new_refresh = body["refreshToken"]
        .as_str()
        .expect("refreshToken")
        .to_string();
    assert!(!new_access.is_empty() && !new_refresh.is_empty());
    assert_ne!(new_access, access, "rotation must mint a new access token");
    assert_ne!(
        new_refresh, refresh,
        "rotation must mint a new refresh token"
    );
    let expires_in = body["expiresIn"].as_i64().expect("expiresIn");
    assert!(
        (1..=900).contains(&expires_in),
        "access TTL is ~900s, got {expires_in}"
    );
    assert_eq!(header_str(&headers, "cache-control"), "no-store");

    // Herald rotated the family for real: replaying the OLD refresh token is a re-sign-in,
    // not a fresh pair.
    let (status, _, body) = send(
        &app.app,
        "POST",
        "/api/auth/refresh",
        &[],
        Some(json!({ "refreshToken": refresh })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a rotated refresh token must be rejected"
    );
    assert_eq!(error_code(&json_of(&body)), "AUTH_REQUIRED");

    // Request-shape errors never reach the provider.
    let (status, _, body) = send(
        &app.app,
        "POST",
        "/api/auth/refresh",
        &[],
        Some(json!({ "refreshToken": "" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&json_of(&body)), "INVALID_INPUT");
    let (status, _, body) = send(&app.app, "POST", "/api/auth/refresh", &[], None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&json_of(&body)), "INVALID_INPUT");

    // Transport failure (dead provider) is fail-closed.
    let dead = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind dead port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        format!("http://127.0.0.1:{port}")
    };
    let dead_app = spawn_herald(&dead).await;
    let (status, _, body) = send(
        &dead_app.app,
        "POST",
        "/api/auth/refresh",
        &[],
        Some(json!({ "refreshToken": "rt-any" })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&json_of(&body)), "AUTH_UNAVAILABLE");
}

static ENV_MUTEX: Mutex<()> = Mutex::new(());

/// Saves and clears the listed variables; restores the originals on drop. a09 is the only
/// consumer of Config::from_env; it holds SUITE while the process-global environment is
/// rewritten, so pool-spawning tests never read a half-swapped DATABASE_URL.
struct EnvRestore {
    saved: Vec<(String, Option<String>)>,
}

impl EnvRestore {
    fn scoped(vars: &[&str]) -> Self {
        let saved = vars
            .iter()
            .map(|v| ((*v).to_string(), std::env::var(v).ok()))
            .collect();
        for v in vars {
            std::env::remove_var(v);
        }
        Self { saved }
    }
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (key, value) in self.saved.drain(..) {
            match value {
                Some(value) => std::env::set_var(&key, value),
                None => std::env::remove_var(&key),
            }
        }
    }
}

const ENV_VARS: [&str; 6] = [
    "AUTH_MODE",
    "HERALD_BASE_URL",
    "HERALD_REALM_ID",
    "HERALD_CLIENT_ID",
    "HERALD_REDIRECT_URI",
    "DATABASE_URL",
];

#[tokio::test]
async fn a09_config_fail_fast_and_modes() {
    // The env rewrite below is process-global: every other test spawns pools that fall back to
    // DATABASE_URL, so this must not overlap them (SUITE), nor future env-rewrite cases (ENV_MUTEX).
    let _suite = SUITE.lock().await;
    let _guard = ENV_MUTEX.lock().unwrap();
    let _restore = EnvRestore::scoped(&ENV_VARS);
    std::env::set_var("DATABASE_URL", "postgres://user:pass@127.0.0.1:5432/db");

    // Default mode with nothing configured: all four variables listed, both exits offered,
    // and no configured value is echoed back.
    std::env::set_var("HERALD_BASE_URL", "https://herald.secret-example.invalid");
    let err = Config::from_env().expect_err("missing Herald config must fail");
    let err = err.to_string();
    assert!(err.contains("AUTH_MODE defaults to 'herald'"), "{err}");
    assert!(
        err.contains("Missing variables: HERALD_REALM_ID, HERALD_CLIENT_ID, HERALD_REDIRECT_URI"),
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

    // A complete valid set assembles the gate — no API-key-like variable is involved.
    std::env::set_var("HERALD_BASE_URL", "https://herald.example.com");
    std::env::set_var("HERALD_REALM_ID", REALM);
    std::env::set_var("HERALD_CLIENT_ID", CLIENT_ID);
    std::env::set_var(
        "HERALD_REDIRECT_URI",
        "https://sync.example.com/api/auth/oauth/callback",
    );
    let config = Config::from_env().expect("complete herald config");
    match &config.auth {
        AuthMode::Herald(herald) => {
            assert_eq!(herald.base_url, "https://herald.example.com");
            assert_eq!(herald.realm_id, REALM);
            assert_eq!(herald.client_id, CLIENT_ID);
        }
        AuthMode::None => panic!("complete configuration must select herald mode"),
    }

    // Loopback HTTP is allowed for local development/testing.
    std::env::set_var("HERALD_BASE_URL", "http://127.0.0.1:9999");
    std::env::set_var(
        "HERALD_REDIRECT_URI",
        "http://127.0.0.1:9999/api/auth/oauth/callback",
    );
    assert!(matches!(
        Config::from_env().expect("loopback config"),
        Config {
            auth: AuthMode::Herald(_),
            ..
        }
    ));

    // Explicit none mode wins even when Herald variables are present.
    std::env::set_var("AUTH_MODE", "none");
    assert!(matches!(
        Config::from_env().expect("explicit none"),
        Config {
            auth: AuthMode::None,
            ..
        }
    ));

    // An unrecognized mode is a startup error.
    std::env::set_var("AUTH_MODE", "maybe");
    let err = Config::from_env().expect_err("bogus AUTH_MODE").to_string();
    assert!(
        err.contains("AUTH_MODE must be 'herald' or 'none'"),
        "{err}"
    );

    // Invalid values fail fast, naming the variable but never the value.
    std::env::set_var("AUTH_MODE", "herald");
    std::env::set_var("HERALD_BASE_URL", "https://herald.example.com/api");
    let err = Config::from_env()
        .expect_err("base URL with a path")
        .to_string();
    assert!(err.contains("HERALD_BASE_URL"), "{err}");
    assert!(
        !err.contains("/api"),
        "value fragments must not be echoed: {err}"
    );

    std::env::set_var("HERALD_BASE_URL", "http://10.0.0.5");
    let err = Config::from_env()
        .expect_err("non-loopback http")
        .to_string();
    assert!(err.contains("HERALD_BASE_URL"), "{err}");

    std::env::set_var("HERALD_BASE_URL", "https://herald.example.com");
    std::env::set_var("HERALD_REALM_ID", "bad/realm");
    let err = Config::from_env()
        .expect_err("realm with a path separator")
        .to_string();
    assert!(err.contains("HERALD_REALM_ID"), "{err}");
    assert!(!err.contains("bad/realm"), "{err}");

    std::env::set_var("HERALD_REALM_ID", REALM);
    std::env::set_var(
        "HERALD_REDIRECT_URI",
        "https://sync.example.com/api/auth/oauth/callback?x=1",
    );
    let err = Config::from_env()
        .expect_err("redirect with a query")
        .to_string();
    assert!(err.contains("HERALD_REDIRECT_URI"), "{err}");

    std::env::set_var(
        "HERALD_REDIRECT_URI",
        "http://10.0.0.5/api/auth/oauth/callback",
    );
    assert!(
        Config::from_env().is_err(),
        "non-loopback http redirect must be rejected"
    );
}
