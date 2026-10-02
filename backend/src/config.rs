// RUST_LOG 由 tracing-subscriber 的 EnvFilter 在 main 中消费，不在此读取。

#[derive(Debug, Clone)]
pub struct Config {
    /// 监听地址，默认 `0.0.0.0:8080`
    pub bind_addr: String,
    /// PostgreSQL 连接串（必填，形如 `postgres://user:pass@host:5432/dbname`）
    pub database_url: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let database_url = std::env::var("DATABASE_URL").unwrap_or_default();
        if database_url.trim().is_empty() {
            anyhow::bail!("DATABASE_URL is required (postgres://user:pass@host:5432/dbname)");
        }
        Ok(Self {
            bind_addr,
            database_url,
        })
    }
}
