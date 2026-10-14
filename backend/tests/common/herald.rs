// Herald plumbing shared by the Herald-auth and workspace-permissions scenario suites: the
// docker container handle, its HTTP/PostgreSQL/Redis surfaces, the inline RESP client behind
// the rate-limit resets, the org-channel client/config assembly and the env-rewrite guard for
// the config tests. Everything here talks to the REAL Herald instance started by
// scripts/test-start.py — no doubles, no mocks. Each suite keeps its own seed, login shape
// and case helpers as `impl Herald` extensions in its own file.

use std::io::{BufRead, BufReader, Read, Write as _};
use std::time::{Duration, Instant};

use oncewise_ai_sync::config::HeraldConfig;
use oncewise_ai_sync::orgs::OrgClient;
use serde_json::Value;

pub(crate) const REALM: &str = "oncewise";
pub(crate) const CLIENT_ID: &str = "oncewise-sync";
// Seeded users reuse the image's bootstrap-admin password hash (admin realm), exactly like
// the rmqtt-things test tooling — so every test user logs in with "password".
pub(crate) const PASSWORD: &str = "password";
// Whitelisted in the seeded client app; nothing serves it (the code comes from the login
// JSON response, and oncewise-ai-sync only exchanges it server-to-server).
pub(crate) const CALLBACK_URI: &str = "http://127.0.0.1:8099/api/auth/oauth/callback";
const HERALD_CONTAINER: &str = "oncewise-test-herald";
/// The org-channel API key seeded into the test Herald's client_api_keys row bound to the BFF
/// client app (scenario_workspace_permissions' seed).
pub(crate) const ORG_API_KEY: &str = "ow-test-org-api-key-0000000000000001";

pub(crate) fn herald_base_url() -> String {
    std::env::var("TEST_HERALD_URL").unwrap_or_else(|_| "http://127.0.0.1:13001".to_string())
}

fn herald_db_url() -> String {
    std::env::var("TEST_HERALD_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:5432/herald_test".to_string())
}

fn herald_redis_addr() -> String {
    std::env::var("TEST_HERALD_REDIS").unwrap_or_else(|_| "127.0.0.1:16381".to_string())
}

/// Direct handle on the real Herald: its HTTP surface, its PostgreSQL (idempotent SQL seeding
/// and fact assertions) and its Redis (rate-limit resets).
pub(crate) struct Herald {
    pub(crate) base: String,
    pub(crate) http: reqwest::Client,
    pub(crate) db: sqlx::PgPool,
    redis: String,
}

impl Herald {
    pub(crate) async fn connect() -> Self {
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

    pub(crate) async fn set_account_status(&self, realm: &str, email: &str, status: i32) {
        sqlx::query("UPDATE account SET status = $1 WHERE realm_id = $2 AND email = $3")
            .bind(status)
            .bind(realm)
            .bind(email)
            .execute(&self.db)
            .await
            .expect("account status update");
    }

    /// Deletes Herald's rl:* keys so login/authorize/token bursts do not trip the
    /// per-IP/per-identifier windows. Minimal inline RESP client — no test dependency.
    pub(crate) fn clear_rate_limits(&self) {
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

    pub(crate) async fn stop_container(&self) {
        docker_output(["stop", HERALD_CONTAINER], "stop the Herald container");
    }

    pub(crate) async fn start_container_and_wait(&self) {
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

pub(crate) fn org_client(base_url: &str) -> OrgClient {
    OrgClient::new(base_url, REALM, ORG_API_KEY).expect("test org client assembly")
}

pub(crate) fn herald_config(base_url: &str) -> HeraldConfig {
    HeraldConfig::new(base_url, REALM, CLIENT_ID, CALLBACK_URI, ORG_API_KEY)
        .expect("test Herald config must be valid (loopback http is allowed)")
}

pub(crate) fn error_code(body: &Value) -> String {
    body["error"]["code"]
        .as_str()
        .unwrap_or("<missing code>")
        .to_string()
}

pub(crate) static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Saves and clears the listed variables; restores the originals on drop. The config tests
/// (a09, w07) are the only consumers of Config::from_env; each holds SUITE while the
/// process-global environment is rewritten, so pool-spawning tests never read a half-swapped
/// DATABASE_URL.
pub(crate) struct EnvRestore {
    saved: Vec<(String, Option<String>)>,
}

impl EnvRestore {
    pub(crate) fn scoped(vars: &[&str]) -> Self {
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

pub(crate) const ENV_VARS: [&str; 7] = [
    "AUTH_MODE",
    "HERALD_BASE_URL",
    "HERALD_REALM_ID",
    "HERALD_CLIENT_ID",
    "HERALD_REDIRECT_URI",
    "HERALD_ORG_API_KEY",
    "DATABASE_URL",
];
