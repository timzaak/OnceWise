// Shared plumbing for the scenario test binaries (scenario_data_sync.rs, scenario_herald_auth.rs):
// one migrated test pool, one generalized oneshot request helper and the shared space keys. A
// directory module (tests/common/mod.rs) is the cargo-standard way to share code between
// integration-test crates without creating another test target.

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

pub const KEY_A: &str = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"; // 32 chars — the space key (shared by all holders)
pub const KEY_B: &str = "jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj"; // 32 chars — a *different* key (wrong for this space)

/// A fresh PostgreSQL database with the production migrations applied (needs TEST_DATABASE_URL
/// or DATABASE_URL pointing at a running PostgreSQL server).
pub async fn migrated_pool() -> sqlx::PgPool {
    let pool = oncewise_ai_sync::db::init_test_pool().await;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migration run failed");
    pool
}

/// One oneshot request with arbitrary headers; returns status, headers and the raw body bytes.
pub async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let request = if let Some(body) = body {
        builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
    } else {
        builder.body(Body::empty())
    }
    .expect("failed to build the test request");
    let response = app.clone().oneshot(request).await.expect("request failed");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("failed to read the response")
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}

/// Parses a response body as JSON; an empty body reads as `null`.
pub fn json_of(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes).expect("body must be valid JSON")
    }
}
