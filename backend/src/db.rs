// PostgreSQL pool assembly. Production always points DATABASE_URL at a pre-created database;
// CREATE_DB_IF_MISSING=1 additionally lets a missing database be created on the same server
// (dev/demo bootstrap only — production never relies on it). Tests isolate per call in a fresh
// database under the server from TEST_DATABASE_URL / DATABASE_URL (see init_test_pool).

use anyhow::Context;
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::Connection;

const MAX_CONNECTIONS: u32 = 8;

pub async fn init_pool(database_url: &str) -> anyhow::Result<PgPool> {
    connect_or_create(database_url, create_db_if_missing())
        .await
        .with_context(|| "failed to connect to PostgreSQL (check DATABASE_URL)")
}

async fn connect_or_create(database_url: &str, allow_create: bool) -> anyhow::Result<PgPool> {
    let connect_err = match try_connect(database_url).await {
        Ok(pool) => return Ok(pool),
        Err(err) => err,
    };
    if allow_create && is_invalid_catalog_name(&connect_err) {
        create_missing_database(database_url).await?;
        return try_connect(database_url).await.map_err(anyhow::Error::new);
    }
    Err(anyhow::Error::new(connect_err))
}

async fn try_connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect(database_url)
        .await
}

/// PostgreSQL SQLSTATE 3D000: the database named in DATABASE_URL does not exist (yet).
fn is_invalid_catalog_name(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .is_some_and(|db| db.code() == Some(std::borrow::Cow::Borrowed("3D000")))
}

fn create_db_if_missing() -> bool {
    std::env::var("CREATE_DB_IF_MISSING").is_ok_and(|v| v == "1")
}

/// Connect to the `postgres` maintenance database on the same server and create the target
/// database. A concurrent creator winning the race surfaces as 42P04 and counts as success.
async fn create_missing_database(database_url: &str) -> anyhow::Result<()> {
    let target = database_name(database_url)?;
    let admin_url = replace_database(database_url, "postgres");
    let mut conn = sqlx::PgConnection::connect(&admin_url)
        .await
        .context("failed to connect to the PostgreSQL maintenance database")?;
    let result = sqlx::raw_sql(&format!(r#"CREATE DATABASE "{target}""#))
        .execute(&mut conn)
        .await;
    match result {
        Ok(_) => Ok(()),
        Err(err)
            if err
                .as_database_error()
                .is_some_and(|db| db.code() == Some(std::borrow::Cow::Borrowed("42P04"))) =>
        {
            Ok(())
        }
        Err(err) => Err(anyhow::Error::new(err).context("failed to create the database")),
    }
}

fn database_name(database_url: &str) -> anyhow::Result<&str> {
    let path = database_url
        .split_once('?')
        .map_or(database_url, |(base, _)| base);
    let name = path
        .rsplit_once('/')
        .map(|(_, name)| name)
        .context("DATABASE_URL must carry a database path (postgres://host:5432/dbname)")?;
    if name.is_empty() {
        anyhow::bail!("DATABASE_URL must carry a database path (postgres://host:5432/dbname)");
    }
    Ok(name)
}

fn replace_database(database_url: &str, database: &str) -> String {
    let (base, query) = match database_url.split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (database_url, None),
    };
    let idx = base.rfind('/').expect("DATABASE_URL carries a path");
    match query {
        Some(query) => format!("{}/{}?{}", &base[..idx], database, query),
        None => format!("{}/{}", &base[..idx], database),
    }
}

/// Fresh database per call for test isolation: `oncewise_ai_test_<unix-millis>_<seq>` under the
/// server from TEST_DATABASE_URL (falling back to DATABASE_URL). The first call in a process also
/// force-drops leftover test databases older than 300 s, so crashed runs do not accumulate; the
/// grace window keeps a concurrently running suite untouched (CI's ephemeral postgres makes the
/// sweep a no-op). Migrations are left to the callers (same as before).
pub async fn init_test_pool() -> PgPool {
    static SWEPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let admin_url = test_admin_url();
    if !SWEPT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        sweep_stale_test_databases(&admin_url).await;
    }
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let database = format!(
        "oncewise_ai_test_{}_{}",
        chrono::Utc::now().timestamp_millis(),
        seq
    );
    connect_or_create(&replace_database(&admin_url, &database), true)
        .await
        .expect("failed to create/connect the test database (is PostgreSQL running?)")
}

fn test_admin_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .expect(
            "tests need TEST_DATABASE_URL or DATABASE_URL pointing at a PostgreSQL server \
             (e.g. postgres://postgres:postgres@127.0.0.1:5432/postgres)",
        )
}

async fn sweep_stale_test_databases(admin_url: &str) {
    // Best-effort: a failed sweep never fails tests, it only leaves old databases behind.
    let Ok(mut conn) = sqlx::PgConnection::connect(admin_url).await else {
        return;
    };
    let names = match sqlx::query_scalar::<_, String>(
        "SELECT datname FROM pg_database WHERE datname LIKE 'oncewise%'",
    )
    .fetch_all(&mut conn)
    .await
    {
        Ok(names) => names,
        Err(_) => return,
    };
    let cutoff = chrono::Utc::now().timestamp_millis() - 300_000;
    for name in names {
        let Some(created) = name
            .strip_prefix("oncewise_ai_test_")
            .and_then(|rest| rest.split('_').next())
            .and_then(|millis| millis.parse::<i64>().ok())
        else {
            continue;
        };
        if created < cutoff {
            let _ = sqlx::raw_sql(&format!(r#"DROP DATABASE "{name}" WITH (FORCE)"#))
                .execute(&mut conn)
                .await;
        }
    }
}

/// The single time source of the whole database: fixed-width RFC 3339 UTC milliseconds — the
/// fixed width guarantees lexicographic order equals chronological order.
pub fn now_utc() -> String {
    format_utc(chrono::Utc::now())
}

/// The only implementation of the time format: any field compared lexicographically against
/// now_utc() output (none today, kept for future expiries) must be produced through this function.
pub fn format_utc(ts: chrono::DateTime<chrono::Utc>) -> String {
    ts.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
