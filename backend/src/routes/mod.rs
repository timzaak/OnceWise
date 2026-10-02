pub mod scripts;
pub mod spaces;

use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use axum::Router;

use crate::error::ApiError;
use crate::AppState;

pub fn build_router(state: AppState) -> Router {
    Router::new()
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
        )
        .route("/api/health", get(spaces::get_health))
        .route("/api/openapi.json", get(crate::openapi::get_openapi))
        .fallback(fallback_not_found)
        .with_state(state)
}

async fn fallback_not_found() -> impl IntoResponse {
    ApiError::NotFound {
        code: "NOT_FOUND",
        message: "No such endpoint".to_string(),
    }
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
        let app = build_router(AppState { pool });

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
