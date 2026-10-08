pub mod auth;
pub mod scripts;
pub mod spaces;

use axum::middleware;
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use axum::Router;

use crate::error::endpoint_not_found;
use crate::AppState;

/// Single assembly point. In herald mode the nine business routes sit behind the sign-in gate
/// and all five auth endpoints are mounted; in none mode only the mode probe `/api/auth/config`
/// exists (the other auth endpoints fall through to the 404 fallback) — the previous behavior
/// plus that one new public probe.
pub fn build_router(state: AppState) -> Router {
    let business = Router::new()
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
    let business = match state.auth {
        Some(_) => business.layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_herald_auth,
        )),
        None => business,
    };

    let router = Router::new()
        .merge(business)
        .route("/api/health", get(spaces::get_health))
        .route("/api/openapi.json", get(crate::openapi::get_openapi))
        .route("/api/auth/config", get(auth::get_auth_config));
    let router = match state.auth {
        Some(_) => router
            .route("/api/auth/oauth/start", get(auth::oauth_start))
            .route("/api/auth/oauth/callback", get(auth::oauth_callback))
            .route("/api/auth/redeem", post(auth::redeem_token))
            .route("/api/auth/refresh", post(auth::refresh_token)),
        None => router,
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
        let app = build_router(AppState { pool, auth: None });

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
}
