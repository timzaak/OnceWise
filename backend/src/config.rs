// RUST_LOG 由 tracing-subscriber 的 EnvFilter 在 main 中消费，不在此读取。

use reqwest::Url;

const HERALD_VARS: [&str; 4] = [
    "HERALD_BASE_URL",
    "HERALD_REALM_ID",
    "HERALD_CLIENT_ID",
    "HERALD_REDIRECT_URI",
];

#[derive(Debug, Clone)]
pub enum AuthMode {
    /// Default: business endpoints sit behind the Herald sign-in gate (fail-fast when the
    /// Herald configuration is incomplete at startup).
    Herald(HeraldConfig),
    /// Explicit opt-out: the pre-gate space-key-only behavior, bit for bit.
    None,
}

#[derive(Debug, Clone)]
pub struct HeraldConfig {
    /// Normalized HTTPS origin (HTTP only on loopback) — base for all Herald requests.
    pub base_url: String,
    /// Deployment-level realm; the status response must match it.
    pub realm_id: String,
    /// OAuth client app id registered in the Herald console.
    pub client_id: String,
    /// The canonical registered callback (…/api/auth/oauth/callback); never derived from
    /// request Host or forwarding headers.
    pub redirect_uri: String,
}

impl HeraldConfig {
    /// Validates the four Herald settings without echoing any value back (variable names only,
    /// so startup errors stay safe to paste into an issue tracker).
    pub fn new(
        base_url: &str,
        realm_id: &str,
        client_id: &str,
        redirect_uri: &str,
    ) -> anyhow::Result<Self> {
        let base = Url::parse(base_url.trim())
            .ok()
            .filter(is_https_or_loopback_http)
            .filter(|u| u.path() == "/" && u.query().is_none() && u.fragment().is_none())
            .map(|u| u.origin().ascii_serialization())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "HERALD_BASE_URL must be an HTTPS origin (HTTP is only allowed on loopback) \
                     without userinfo, path, query or fragment"
                )
            })?;

        let realm = realm_id.trim();
        if realm.is_empty()
            || realm.len() > 256
            || realm
                .chars()
                .any(|c| c == '/' || c == '\\' || c.is_whitespace() || c.is_control())
        {
            anyhow::bail!(
                "HERALD_REALM_ID must be 1–256 characters without path separators, whitespace \
                 or control characters"
            );
        }

        let client = client_id.trim();
        if client.is_empty() || client.len() > 256 {
            anyhow::bail!("HERALD_CLIENT_ID must be 1–256 characters");
        }

        let redirect = Url::parse(redirect_uri.trim())
            .ok()
            .filter(is_https_or_loopback_http)
            .filter(|u| u.path() == "/api/auth/oauth/callback")
            .filter(|u| u.query().is_none() && u.fragment().is_none())
            .map(|u| u.to_string())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "HERALD_REDIRECT_URI must be an HTTPS URL (HTTP is only allowed on loopback) \
                     whose path is exactly /api/auth/oauth/callback, without query or fragment"
                )
            })?;

        Ok(Self {
            base_url: base,
            realm_id: realm.to_string(),
            client_id: client.to_string(),
            redirect_uri: redirect,
        })
    }
}

fn is_https_or_loopback_http(url: &Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => url.host_str().is_some_and(is_loopback_host),
        _ => false,
    }
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host == "[::1]"
        || host == "::1"
        || host.strip_prefix("127.").is_some_and(|rest| {
            // 127.0.0.0/8: every remaining dot-separated segment is non-empty digits.
            rest.split('.')
                .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()))
        })
}

#[derive(Debug, Clone)]
pub struct Config {
    /// 监听地址，默认 `0.0.0.0:8080`
    pub bind_addr: String,
    /// PostgreSQL 连接串（必填，形如 `postgres://user:pass@host:5432/dbname`）
    pub database_url: String,
    /// Sign-in gate: Herald by default, explicit `none` keeps the previous behavior.
    pub auth: AuthMode,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let database_url = std::env::var("DATABASE_URL").unwrap_or_default();
        if database_url.trim().is_empty() {
            anyhow::bail!("DATABASE_URL is required (postgres://user:pass@host:5432/dbname)");
        }
        let auth = Self::auth_mode_from_env()?;
        Ok(Self {
            bind_addr,
            database_url,
            auth,
        })
    }

    fn auth_mode_from_env() -> anyhow::Result<AuthMode> {
        let mode = std::env::var("AUTH_MODE").unwrap_or_default();
        let mode = mode.trim();
        if mode.is_empty() || mode == "herald" {
            let vars = HERALD_VARS.map(|name| (name, std::env::var(name).unwrap_or_default()));
            let missing: Vec<&str> = vars
                .iter()
                .filter(|(_, value)| value.trim().is_empty())
                .map(|(name, _)| *name)
                .collect();
            if !missing.is_empty() {
                anyhow::bail!(
                    "AUTH_MODE defaults to 'herald', which requires Herald configuration.\n\
                     Missing variables: {}\n\
                     Either supply the missing variables to enable sign-in,\n\
                     or set AUTH_MODE=none to retain the previous behavior explicitly.",
                    missing.join(", ")
                );
            }
            let config = HeraldConfig::new(
                vars[0].1.trim(),
                vars[1].1.trim(),
                vars[2].1.trim(),
                vars[3].1.trim(),
            )?;
            return Ok(AuthMode::Herald(config));
        }
        if mode == "none" {
            // Names only, never values: the operator just needs to know the settings were ignored.
            let ignored: Vec<&str> = HERALD_VARS
                .iter()
                .filter(|name| std::env::var(name).is_ok_and(|v| !v.trim().is_empty()))
                .copied()
                .collect();
            if !ignored.is_empty() {
                tracing::info!(
                    "AUTH_MODE=none: ignoring {} (the space-key-only behavior is active)",
                    ignored.join(", ")
                );
            }
            return Ok(AuthMode::None);
        }
        anyhow::bail!("AUTH_MODE must be 'herald' or 'none' (got an unrecognized value)");
    }
}
