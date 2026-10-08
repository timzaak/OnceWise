use anyhow::Context;
use oncewise_ai_sync::routes::auth::HeraldAuth;
use oncewise_ai_sync::{config, db, routes, AppState};
use tower_http::trace::TraceLayer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    let config = config::Config::from_env()?;

    let pool = db::init_pool(&config.database_url)
        .await
        .context("failed to init the PostgreSQL pool")?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("failed to run database migrations")?;

    let auth = match &config.auth {
        config::AuthMode::Herald(herald) => Some(
            HeraldAuth::new(herald.clone())
                .context("failed to assemble the Herald sign-in gate")?,
        ),
        config::AuthMode::None => None,
    };
    let state = AppState { pool, auth };
    if let Some(herald) = state.auth.as_ref() {
        // Drops expired login handshakes even during idle periods; exits with the server state.
        herald.start_sweep_task();
    }
    let app = routes::build_router(state).layer(TraceLayer::new_for_http().make_span_with(
        // Only method + path: the default span records the full URI, which would put OAuth
        // query parameters (state, code) into logs.
        |request: &axum::http::Request<axum::body::Body>| {
            tracing::info_span!(
                "http_request",
                method = %request.method(),
                path = %request.uri().path()
            )
        },
    ));

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", config.bind_addr))?;
    tracing::info!("oncewise-ai-sync listening on {}", config.bind_addr);
    axum::serve(listener, app)
        .await
        .context("http server exited unexpectedly")?;
    Ok(())
}

/// RUST_LOG defaults to info; logging discipline: never log flow content or space keys.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}
