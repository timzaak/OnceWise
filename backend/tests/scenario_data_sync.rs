// Scenario tests: real HTTP requests through tower::ServiceExt::oneshot, asserting status codes and
// response bodies (including the unified error-body codes). Each case gets a fresh PostgreSQL
// database from db::init_test_pool (same migration source as production; needs TEST_DATABASE_URL
// or DATABASE_URL pointing at a running PostgreSQL server).
// Story mapping: s01–s10 correspond to US-DS-001～006 (docs/user-stories/core/data-sync.md).

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use oncewise_ai_sync::{routes, AppState};
use serde_json::{json, Value};
use tower::ServiceExt;

const KEY_A: &str = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"; // 32 chars — the space key (shared by all holders)
const KEY_B: &str = "jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj"; // 32 chars — a *different* key (wrong for this space)

struct TestApp {
    app: Router,
    pool: sqlx::PgPool,
}

async fn spawn() -> TestApp {
    let pool = oncewise_ai_sync::db::init_test_pool().await;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migration run failed");
    TestApp {
        app: routes::build_router(AppState { pool: pool.clone() }),
        pool,
    }
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    key: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(key) = key {
        builder = builder.header("X-Space-Key", key);
    }
    let request = if let Some(body) = body {
        builder = builder.header("content-type", "application/json");
        builder.body(Body::from(body.to_string()))
    } else {
        builder.body(Body::empty())
    }
    .expect("failed to build the test request");
    let response = app.clone().oneshot(request).await.expect("request failed");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("failed to read the response")
        .to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("responses must be valid JSON")
    };
    (status, value)
}

fn flow_content(v: u32) -> Value {
    json!({
        "schemaVersion": 2,
        "id": "cloud-id",
        "status": "enabled",
        "provenance": { "source": "import", "createdAt": 0, "updatedAt": 0 },
        "name": format!("Flow v{v}"),
        "site": "https://saas.example.com",
        "page": { "urlIncludes": "#/shipment" },
        "trigger": { "kind": "pageEnter" },
        "actions": [{
            "kind": "setInputValue",
            "target": { "clues": { "id": "phone" }, "componentType": "input", "displayLabel": "Phone" },
            "value": { "kind": "constant", "value": "13800001234" }
        }]
    })
}

/// Registers a space with a stable id and KEY_A; returns the space id.
async fn make_space(app: &TestApp) -> String {
    let (status, body) = send(
        &app.app,
        "POST",
        "/api/spaces",
        None,
        Some(json!({ "id": "sp-scenario0000001", "key": KEY_A, "name": "Team Space" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "space registration failed: {body}"
    );
    "sp-scenario0000001".to_string()
}

fn script_uri(space_id: &str) -> String {
    format!("/api/spaces/{space_id}/scripts")
}

fn one_script_uri(space_id: &str, script_id: &str) -> String {
    format!("{}/{}", script_uri(space_id), script_id)
}

fn versions_uri(space_id: &str, script_id: &str) -> String {
    format!("{}/versions", one_script_uri(space_id, script_id))
}

fn version_uri(space_id: &str, script_id: &str, version_number: i64) -> String {
    format!("{}/{}", versions_uri(space_id, script_id), version_number)
}

#[tokio::test]
async fn s01_space_registration_is_idempotent_per_key_and_conflicts_otherwise() {
    let app = spawn().await;
    let first = send(
        &app.app,
        "POST",
        "/api/spaces",
        None,
        Some(json!({ "id": "sp-idem000000000001", "key": KEY_A, "name": "Space" })),
    )
    .await;
    assert_eq!(first.0, StatusCode::CREATED);

    // Same id + same key → 200 idempotent (device reinstall)
    let again = send(
        &app.app,
        "POST",
        "/api/spaces",
        None,
        Some(json!({ "id": "sp-idem000000000001", "key": KEY_A, "name": "Space" })),
    )
    .await;
    assert_eq!(again.0, StatusCode::OK);
    assert_eq!(again.1["name"], "Space");

    // Same id + different key → 409 SPACE_KEY_MISMATCH (no takeover)
    let clash = send(
        &app.app,
        "POST",
        "/api/spaces",
        None,
        Some(json!({ "id": "sp-idem000000000001", "key": KEY_B, "name": "Evil" })),
    )
    .await;
    assert_eq!(clash.0, StatusCode::CONFLICT);
    assert_eq!(clash.1["error"]["code"], "SPACE_KEY_MISMATCH");

    // Malformed shapes → 400
    for bad in [
        json!({ "id": "x", "key": KEY_A, "name": "Bad id" }),
        json!({ "id": "sp-valid00000000001", "key": "short", "name": "Bad key" }),
        json!({ "id": "sp-valid00000000001", "key": KEY_A, "name": "" }),
    ] {
        let res = send(&app.app, "POST", "/api/spaces", None, Some(bad)).await;
        assert_eq!(
            res.0,
            StatusCode::BAD_REQUEST,
            "shape check failed: {}",
            res.1
        );
    }
}

#[tokio::test]
async fn s02_space_read_verifies_the_key_and_hides_unknown_ids() {
    let app = spawn().await;
    make_space(&app).await;

    let ok = send(
        &app.app,
        "GET",
        "/api/spaces/sp-scenario0000001",
        Some(KEY_A),
        None,
    )
    .await;
    assert_eq!(ok.0, StatusCode::OK);
    assert_eq!(ok.1["name"], "Team Space");

    // Wrong key → 401 BAD_SPACE_KEY (the id is not revealed to exist)
    let wrong = send(
        &app.app,
        "GET",
        "/api/spaces/sp-scenario0000001",
        Some(KEY_B),
        None,
    )
    .await;
    assert_eq!(wrong.0, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.1["error"]["code"], "BAD_SPACE_KEY");

    // Missing header → 401 without a database roundtrip
    let none = send(
        &app.app,
        "GET",
        "/api/spaces/sp-scenario0000001",
        None,
        None,
    )
    .await;
    assert_eq!(none.0, StatusCode::UNAUTHORIZED);

    // Unknown id → 404 SPACE_NOT_FOUND
    let missing = send(
        &app.app,
        "GET",
        "/api/spaces/sp-missing000000001",
        Some(KEY_A),
        None,
    )
    .await;
    assert_eq!(missing.0, StatusCode::NOT_FOUND);
    assert_eq!(missing.1["error"]["code"], "SPACE_NOT_FOUND");
}

#[tokio::test]
async fn s03_any_key_holder_has_full_access_no_roles_no_members() {
    let app = spawn().await;
    let space_id = make_space(&app).await;

    // A second device holding the same key never "joined" anything — there is no join step and no
    // role table; holding the key is the entire access model (read + write symmetric)
    let created = send(
        &app.app,
        "POST",
        &script_uri(&space_id),
        Some(KEY_A),
        Some(json!({ "id": "sc-teammate000000001", "name": "From device B", "note": "", "versionNote": "v1", "flowContent": flow_content(1) })),
    )
    .await;
    assert_eq!(
        created.0,
        StatusCode::CREATED,
        "any key holder must be able to write: {}",
        created.1
    );

    let listed = send(&app.app, "GET", &script_uri(&space_id), Some(KEY_A), None).await;
    assert_eq!(listed.0, StatusCode::OK);
    assert_eq!(listed.1.as_array().unwrap().len(), 1);

    // A different key grants nothing
    let denied = send(&app.app, "GET", &script_uri(&space_id), Some(KEY_B), None).await;
    assert_eq!(denied.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn s04_script_create_lists_and_duplicate_ids() {
    let app = spawn().await;
    let space_id = make_space(&app).await;

    let created = send(
        &app.app,
        "POST",
        &script_uri(&space_id),
        Some(KEY_A),
        Some(json!({ "id": "sc-create00000000001", "name": "  Ship helper  ", "note": "note", "versionNote": "first", "flowContent": flow_content(1) })),
    )
    .await;
    assert_eq!(created.0, StatusCode::CREATED);
    assert_eq!(created.1["name"], "Ship helper"); // trimmed
    assert_eq!(created.1["latestVersionNumber"], 1);
    assert_eq!(created.1["latestVersionNote"], "first");

    let listed = send(&app.app, "GET", &script_uri(&space_id), Some(KEY_A), None).await;
    assert_eq!(listed.0, StatusCode::OK);
    assert_eq!(listed.1[0]["id"], "sc-create00000000001");

    // Duplicate id → 409 SCRIPT_EXISTS (globally unique client ids)
    let dup = send(
        &app.app,
        "POST",
        &script_uri(&space_id),
        Some(KEY_A),
        Some(json!({ "id": "sc-create00000000001", "name": "Dup", "note": "", "versionNote": "", "flowContent": flow_content(1) })),
    )
    .await;
    assert_eq!(dup.0, StatusCode::CONFLICT);
    assert_eq!(dup.1["error"]["code"], "SCRIPT_EXISTS");

    // flowContent must be a JSON object
    let not_object = send(
        &app.app,
        "POST",
        &script_uri(&space_id),
        Some(KEY_A),
        Some(json!({ "id": "sc-other000000000001", "name": "Bad", "note": "", "versionNote": "", "flowContent": json!([1, 2]) })),
    )
    .await;
    assert_eq!(not_object.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn s05_rename_updates_metadata_without_creating_a_version() {
    let app = spawn().await;
    let space_id = make_space(&app).await;
    send(
        &app.app,
        "POST",
        &script_uri(&space_id),
        Some(KEY_A),
        Some(json!({ "id": "sc-rename00000000001", "name": "Old", "note": "old note", "versionNote": "", "flowContent": flow_content(1) })),
    )
    .await;

    let patched = send(
        &app.app,
        "PATCH",
        &one_script_uri(&space_id, "sc-rename00000000001"),
        Some(KEY_A),
        Some(json!({ "name": "New name", "note": "new note" })),
    )
    .await;
    assert_eq!(patched.0, StatusCode::OK);
    assert_eq!(patched.1["name"], "New name");
    assert_eq!(patched.1["note"], "new note");
    // Still v1 — metadata changes never create versions
    assert_eq!(patched.1["latestVersionNumber"], 1);

    let versions = send(
        &app.app,
        "GET",
        &versions_uri(&space_id, "sc-rename00000000001"),
        Some(KEY_A),
        None,
    )
    .await;
    assert_eq!(versions.1.as_array().unwrap().len(), 1);

    // Neither name nor note → 400
    let empty = send(
        &app.app,
        "PATCH",
        &one_script_uri(&space_id, "sc-rename00000000001"),
        Some(KEY_A),
        Some(json!({})),
    )
    .await;
    assert_eq!(empty.0, StatusCode::BAD_REQUEST);

    // Unknown script → 404 SCRIPT_NOT_FOUND
    let ghost = send(
        &app.app,
        "PATCH",
        &one_script_uri(&space_id, "sc-missing000000001"),
        Some(KEY_A),
        Some(json!({ "name": "X" })),
    )
    .await;
    assert_eq!(ghost.0, StatusCode::NOT_FOUND);
    assert_eq!(ghost.1["error"]["code"], "SCRIPT_NOT_FOUND");
}

#[tokio::test]
async fn s06_versions_are_serial_immutable_and_globally_fetchable() {
    let app = spawn().await;
    let space_id = make_space(&app).await;
    send(
        &app.app,
        "POST",
        &script_uri(&space_id),
        Some(KEY_A),
        Some(json!({ "id": "sc-vers0000000000001", "name": "Versions", "note": "", "versionNote": "v1", "flowContent": flow_content(1) })),
    )
    .await;

    // Server allocates v2 then v3 (MAX+1, clients never propose numbers)
    for (i, note) in ["second", "third"].iter().enumerate() {
        let res = send(
            &app.app,
            "POST",
            &versions_uri(&space_id, "sc-vers0000000000001"),
            Some(KEY_A),
            Some(json!({ "versionNote": note, "flowContent": flow_content(2 + i as u32) })),
        )
        .await;
        assert_eq!(
            res.0,
            StatusCode::CREATED,
            "version append failed: {}",
            res.1
        );
        assert_eq!(res.1["versionNumber"], 2 + i as i64);
    }

    // List is versionNumber desc with notes intact
    let versions = send(
        &app.app,
        "GET",
        &versions_uri(&space_id, "sc-vers0000000000001"),
        Some(KEY_A),
        None,
    )
    .await;
    let arr = versions.1.as_array().unwrap();
    assert_eq!(arr.len(), 3);
    assert_eq!(arr[0]["versionNumber"], 3);
    assert_eq!(arr[2]["note"], "v1");

    // v1 content is the immutable original (no rewrite by later publishes)
    let v1 = send(
        &app.app,
        "GET",
        &version_uri(&space_id, "sc-vers0000000000001", 1),
        Some(KEY_A),
        None,
    )
    .await;
    assert_eq!(v1.0, StatusCode::OK);
    assert_eq!(v1.1["flowContent"]["name"], "Flow v1");

    // Missing version → 404 VERSION_NOT_FOUND; non-canonical number → 400
    let missing = send(
        &app.app,
        "GET",
        &version_uri(&space_id, "sc-vers0000000000001", 9),
        Some(KEY_A),
        None,
    )
    .await;
    assert_eq!(missing.0, StatusCode::NOT_FOUND);
    assert_eq!(missing.1["error"]["code"], "VERSION_NOT_FOUND");
    let malformed = send(
        &app.app,
        "GET",
        &format!(
            "{}/versions/007",
            one_script_uri(&space_id, "sc-vers0000000000001")
        ),
        Some(KEY_A),
        None,
    )
    .await;
    assert_eq!(malformed.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn s07_scripts_never_leak_across_spaces() {
    let app = spawn().await;
    let space_a = make_space(&app).await;
    send(
        &app.app,
        "POST",
        "/api/spaces",
        None,
        Some(json!({ "id": "sp-scenario0000002", "key": KEY_B, "name": "Other Space" })),
    )
    .await;
    let space_b = "sp-scenario0000002".to_string();

    send(
        &app.app,
        "POST",
        &script_uri(&space_a),
        Some(KEY_A),
        Some(json!({ "id": "sc-isol0000000000001", "name": "A's script", "note": "", "versionNote": "", "flowContent": flow_content(1) })),
    )
    .await;

    // B's list is empty; B cannot read, version, patch or fetch A's script by its id inside B's own
    // space-scoped routes (valid key for B's space + foreign script id → 404, not data)
    let listed_b = send(&app.app, "GET", &script_uri(&space_b), Some(KEY_B), None).await;
    assert_eq!(listed_b.1.as_array().unwrap().len(), 0);

    let foreign_script = "sc-isol0000000000001"; // created under space_a
    for (method, uri, body) in [
        ("GET", versions_uri(&space_b, foreign_script), None),
        ("GET", version_uri(&space_b, foreign_script, 1), None),
        (
            "PATCH",
            one_script_uri(&space_b, foreign_script),
            Some(json!({ "name": "Stolen" })),
        ),
    ] {
        let res = send(&app.app, method, &uri, Some(KEY_B), body).await;
        assert_eq!(
            res.0,
            StatusCode::NOT_FOUND,
            "cross-space leak via {method} {uri}: {}",
            res.1
        );
        assert_eq!(res.1["error"]["code"], "SCRIPT_NOT_FOUND");
    }
}

#[tokio::test]
async fn s08_deleting_a_space_cascades_and_revokes_access() {
    let app = spawn().await;
    let space_id = make_space(&app).await;
    send(
        &app.app,
        "POST",
        &script_uri(&space_id),
        Some(KEY_A),
        Some(json!({ "id": "sc-del00000000000001", "name": "Doomed", "note": "", "versionNote": "", "flowContent": flow_content(1) })),
    )
    .await;

    // Wrong key cannot delete
    let denied = send(
        &app.app,
        "DELETE",
        &format!("/api/spaces/{space_id}"),
        Some(KEY_B),
        None,
    )
    .await;
    assert_eq!(denied.0, StatusCode::UNAUTHORIZED);

    let gone = send(
        &app.app,
        "DELETE",
        &format!("/api/spaces/{space_id}"),
        Some(KEY_A),
        None,
    )
    .await;
    assert_eq!(gone.0, StatusCode::NO_CONTENT);

    // Everything under it is gone; further access is 404 SPACE_NOT_FOUND
    let after = send(&app.app, "GET", &script_uri(&space_id), Some(KEY_A), None).await;
    assert_eq!(after.0, StatusCode::NOT_FOUND);
    assert_eq!(after.1["error"]["code"], "SPACE_NOT_FOUND");

    // Cascade removed the rows (direct database assertion)
    let scripts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scripts")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    let versions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM script_versions")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        (scripts, versions),
        (0, 0),
        "cascade delete must remove scripts and versions"
    );
}

#[tokio::test]
async fn s09_flow_content_backstop_limits() {
    let app = spawn().await;
    let space_id = make_space(&app).await;

    // A string of >256 KiB inside an otherwise valid object exceeds the limit once serialized
    let big = "x".repeat(262_145);
    let res = send(
        &app.app,
        "POST",
        &script_uri(&space_id),
        Some(KEY_A),
        Some(json!({ "id": "sc-big00000000000001", "name": "Big", "note": "", "versionNote": "", "flowContent": { "blob": big } })),
    )
    .await;
    assert_eq!(res.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn s10_openapi_document_is_served() {
    let app = spawn().await;
    let (status, body) = send(&app.app, "GET", "/api/openapi.json", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body["paths"]["/api/spaces"].is_object(),
        "spaces path missing from the document"
    );
    // The security scheme documents the header key contract
    let scheme = &body["components"]["securitySchemes"]["space_key"];
    assert_eq!(scheme["type"], "apiKey");
    assert_eq!(scheme["in"], "header");
    assert_eq!(scheme["name"], "X-Space-Key");
}
