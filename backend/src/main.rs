use anyhow::Context;
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

    let state = AppState { pool };
    let app = routes::build_router(state).layer(TraceLayer::new_for_http());

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
