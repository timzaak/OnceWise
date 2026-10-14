pub mod auth;
pub mod scripts;
pub mod spaces;
pub mod workspace;

use axum::middleware;
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use axum::Router;

use crate::error::endpoint_not_found;
use crate::AppState;

/// Single assembly point. In herald mode the nine business routes plus the workspace surface
/// (org-bound spaces: invites, member management, ownership transfer) sit behind the sign-in
/// gate and all five auth endpoints are mounted; in none mode only the mode probe
/// `/api/auth/config` and the key-addressed business routes exist (the other auth endpoints
/// and the workspace endpoints fall through to the 404 fallback) — the previous behavior
/// plus that one new public probe.
pub fn build_router(state: AppState) -> Router {
    let mut business = Router::new()
        .route("/api/spaces", post(spaces::create_space))
        .route(
            "/api/spaces/{spaceId}",
            get(spaces::get_space).delete(spaces::delete_space),
        )
        .route(
            "/api/spaces/{spaceId}/scripts",
            post(scripts::create_script).get(scripts::list_scripts),
        )
        .route(
            "/api/spaces/{spaceId}/scripts/{scriptId}",
            patch(scripts::update_script),
        )
        .route(
            "/api/spaces/{spaceId}/scripts/{scriptId}/versions",
            post(scripts::create_script_version).get(scripts::list_script_versions),
        )
        .route(
            "/api/spaces/{spaceId}/scripts/{scriptId}/versions/{versionNumber}",
            get(scripts::get_script_version),
        );
    let gated = state.auth.is_some();
    if gated {
        // Workspace surface: org-bound spaces only — absent (404) in none mode.
        business = business
            .route("/api/invites/redeem", post(workspace::redeem_invite))
            .route(
                "/api/spaces/{spaceId}/invites",
                post(workspace::issue_space_invite),
            )
            .route(
                "/api/spaces/{spaceId}/members",
                get(workspace::list_space_members),
            )
            .route(
                "/api/spaces/{spaceId}/members/{userId}",
                patch(workspace::update_space_member_role).delete(workspace::remove_space_member),
            )
            .route(
                "/api/spaces/{spaceId}/ownership",
                post(workspace::transfer_space_ownership),
            );
    }
    let business = if gated {
        business.layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_herald_auth,
        ))
    } else {
        business
    };

    let router = Router::new()
        .merge(business)
        .route("/api/health", get(spaces::get_health))
        .route("/api/openapi.json", get(crate::openapi::get_openapi))
        .route("/api/auth/config", get(auth::get_auth_config));
    let router = if gated {
        router
            .route("/api/auth/oauth/start", get(auth::oauth_start))
            .route("/api/auth/oauth/callback", get(auth::oauth_callback))
            .route("/api/auth/redeem", post(auth::redeem_token))
            .route("/api/auth/refresh", post(auth::refresh_token))
    } else {
        router
    };
    router.fallback(fallback_not_found).with_state(state)
}

async fn fallback_not_found() -> impl IntoResponse {
    endpoint_not_found()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn skeleton_smoke_health_and_fallback() {
        let pool = crate::db::init_test_pool().await;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migration run failed");
        let app = build_router(AppState {
            pool,
            auth: None,
            org: None,
        });

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("ok"), "health probe body unexpected: {text}");

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/no-such-route")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("NOT_FOUND"),
            "fallback body unexpected: {text}"
        );
    }

    // None mode must not mount the workspace surface: the endpoints fall through to the 404
    // fallback — no new behavior without the sign-in mode.
    #[tokio::test]
    async fn workspace_routes_absent_in_none_mode() {
        let pool = crate::db::init_test_pool().await;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migration run failed");
        let app = build_router(AppState {
            pool,
            auth: None,
            org: None,
        });
        for (method, uri, has_body) in [
            ("POST", "/api/invites/redeem", true),
            ("POST", "/api/spaces/sp-x/invites", false),
            ("GET", "/api/spaces/sp-x/members", false),
            ("PATCH", "/api/spaces/sp-x/members/u", true),
            ("DELETE", "/api/spaces/sp-x/members/u", false),
            ("POST", "/api/spaces/sp-x/ownership", true),
        ] {
            let mut builder = Request::builder().method(method).uri(uri);
            if has_body {
                builder = builder.header("content-type", "application/json");
            }
            let body = if has_body {
                Body::from("{}")
            } else {
                Body::empty()
            };
            let response = app
                .clone()
                .oneshot(builder.body(body).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "{method} {uri} must be absent in none mode"
            );
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let code = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| v["error"]["code"].as_str().map(str::to_string))
                .unwrap_or_default();
            assert_eq!(code, "NOT_FOUND", "{method} {uri}");
        }
    }
}
