// The Herald sign-in gate: one middleware in front of the nine business endpoints plus five
// public auth endpoints (mode probe, OAuth Code+PKCE BFF, one-time handoff redemption, refresh
// proxy). The only question asked is "is this a valid signed-in user for this realm" — no
// permission points, roles or caches; the per-request status check keeps account suspension and
// outages visible on the very next request. Tokens never appear in URLs or logs: the OAuth
// callback hands back only a 60 s single-use handoff code bound to a proof the extension keeps
// in memory, and the tokens themselves travel solely in the POST /api/auth/redeem body.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use anyhow::Context as _;
use axum::extract::{Query, Request, State};
use axum::http::header::{CACHE_CONTROL, COOKIE, LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config::HeraldConfig;
use crate::dto::{AuthConfigDto, ErrorBodyDto, RedeemTokenReq, RefreshTokenReq, TokenSetDto};
use crate::error::{auth_unavailable, endpoint_not_found, ApiError, ApiJson};
use crate::spacekey::constant_time_eq;
use crate::AppState;

/// Login-transaction lifetime; the server-side expiry is authoritative (the cookie's Max-Age is
/// only a client hint).
const TXN_TTL: Duration = Duration::from_secs(300);
/// Handoff-code lifetime, counted from the moment the token response arrives (never re-based at
/// redemption).
const HANDOFF_TTL: Duration = Duration::from_secs(60);
/// Bound for both short-lived maps; a full map answers "temporarily unavailable" instead of
/// growing without limit.
const STATE_CAPACITY: usize = 128;
/// Budget for every Herald round trip (status check, token exchange, refresh proxy).
const HERALD_TIMEOUT: Duration = Duration::from_secs(10);
/// Hard input caps: tokens and authorization codes.
const MAX_TOKEN_LEN: usize = 4096;
/// 32 random bytes as unpadded base64url.
const HANDOFF_CODE_LEN: usize = 43;
/// 32 random bytes as hex (transaction id, OAuth state).
const HEX_32_LEN: usize = 64;
const COOKIE_NAME_SECURE: &str = "__Host-OW_SYNC_OAUTH";
const COOKIE_NAME_PLAIN: &str = "OW_SYNC_OAUTH";

/// Injectable monotonic clock: scenario tests advance expiry without sleeping minutes.
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

struct OAuthTxn {
    state: String,
    code_verifier: String,
    final_uri: String,
    handoff_challenge: String,
    expires_at: Instant,
}

struct Handoff {
    tokens: TokenSetDto,
    handoff_challenge: String,
    issued_at: Instant,
}

#[derive(Default)]
struct TransientState {
    txns: HashMap<String, OAuthTxn>,
    handoffs: HashMap<String, Handoff>,
}

/// Per-deployment Herald integration state: shared HTTP client, immutable config and the
/// short-lived login state (single-instance or session-affinity deployments only — a restart
/// simply means an unfinished sign-in has to be restarted).
#[derive(Clone)]
pub struct HeraldAuth {
    http: reqwest::Client,
    config: HeraldConfig,
    cookie_name: &'static str,
    secure_cookie: bool,
    state: Arc<Mutex<TransientState>>,
    now: Clock,
}

impl HeraldAuth {
    pub fn new(config: HeraldConfig) -> anyhow::Result<Self> {
        Self::with_clock(config, Arc::new(Instant::now))
    }

    /// Test-visible constructor with an explicit clock (`new` uses the real one).
    pub fn with_clock(config: HeraldConfig, now: Clock) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(HERALD_TIMEOUT)
            // Redirects are never followed: a Bearer/token POST must not be steered to another
            // origin by a malicious or misconfigured response.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("failed to build the Herald HTTP client")?;
        let secure_cookie = config.redirect_uri.starts_with("https://");
        Ok(Self {
            http,
            cookie_name: if secure_cookie {
                COOKIE_NAME_SECURE
            } else {
                COOKIE_NAME_PLAIN
            },
            secure_cookie,
            config,
            state: Arc::default(),
            now,
        })
    }

    fn now(&self) -> Instant {
        (self.now)()
    }

    fn lock(&self) -> MutexGuard<'_, TransientState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Every 15 s, drop expired entries even when nobody touches the endpoints. The task holds
    /// only a Weak reference, so it exits once the server (e.g. a test instance) is dropped.
    pub fn start_sweep_task(&self) -> tokio::task::JoinHandle<()> {
        let weak: Weak<Mutex<TransientState>> = Arc::downgrade(&self.state);
        let clock = self.now.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(15));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(state) = weak.upgrade() else { break };
                let now = (clock)();
                state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .sweep_at(now);
            }
        })
    }

    /// The per-request identity check: GET /api/auth/status with the caller's Bearer token. Only
    /// authenticated/userId/realmId participate in the decision; other fields the provider may
    /// add (permissions, scopes, …) are ignored.
    async fn check_sign_in(&self, token: &str) -> Result<(), ApiError> {
        let url = format!("{}/api/auth/status", self.config.base_url);
        let response = match self.http.get(&url).bearer_auth(token).send().await {
            Ok(response) => response,
            // The error Display carries the URL only — the token lives in a header, never there.
            Err(err) => {
                tracing::debug!("herald status request failed: {err}");
                return Err(auth_unavailable());
            }
        };
        match response.status().as_u16() {
            200 => {
                // A missing/wrong-typed field must not default into "valid": a missing
                // `authenticated` is a contract violation (503), an explicit false is an
                // identity that was never established (401).
                let wire: StatusWire = response.json().await.map_err(|_| contract_violation())?;
                match wire.authenticated {
                    Some(true) => {}
                    Some(false) => return Err(ApiError::AuthRequired),
                    None => return Err(contract_violation()),
                }
                if wire.user_id.as_deref().is_none_or(|id| id.is_empty()) {
                    return Err(contract_violation());
                }
                if wire.realm_id.as_deref() != Some(self.config.realm_id.as_str()) {
                    return Err(ApiError::AuthUnavailable {
                        message: "The sign-in server answered for a different realm; check the \
                                   server's HERALD_REALM_ID configuration"
                            .to_string(),
                    });
                }
                Ok(())
            }
            401 => Err(ApiError::AuthRequired),
            _ => Err(auth_unavailable()),
        }
    }
}

impl TransientState {
    fn sweep_at(&mut self, now: Instant) {
        self.txns.retain(|_, txn| txn.expires_at > now);
        self.handoffs
            .retain(|_, handoff| handoff.issued_at + HANDOFF_TTL > now);
    }
}

fn contract_violation() -> ApiError {
    ApiError::AuthUnavailable {
        message: "The sign-in server answered outside the expected contract".to_string(),
    }
}

/// Flat camelCase status body (extra fields are ignored by design).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusWire {
    authenticated: Option<bool>,
    user_id: Option<String>,
    realm_id: Option<String>,
}

/// OAuth token endpoint body (snake_case per the OAuth token response).
#[derive(Deserialize)]
struct OAuthTokenWire {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expires_in: i64,
    refresh_expires_in: i64,
}

/// browser-token refresh body (camelCase, tokenType optional).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshWire {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    refresh_expires_in: i64,
    token_type: Option<String>,
}

/// Business-endpoint gate: Bearer first (401 without a Herald round trip on bad input), then the
/// status check; only an explicit success reaches the handler — the original space-key check
/// runs afterwards, unchanged.
pub async fn require_herald_auth(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    // Only mounted in herald mode; the pass-through keeps none-mode semantics if assembly ever
    // changes.
    let Some(auth) = state.auth.as_ref() else {
        return Ok(next.run(req).await);
    };
    let token = bearer_token(req.headers())?;
    auth.check_sign_in(&token).await?;
    Ok(next.run(req).await)
}

/// Extracts the Bearer token: a missing header, another scheme or an empty token is an
/// unauthenticated request (401, no Herald call); an overlong token is a malformed one (400).
/// The token is trimmed before both checks and forwarding — judging the trimmed value but
/// sending the raw one would let whitespace-padded tokens pass locally and fail at Herald.
fn bearer_token(headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::AuthRequired)?;
    let (scheme, token) = value.split_once(' ').unwrap_or(("", ""));
    let token = token.trim();
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return Err(ApiError::AuthRequired);
    }
    if token.len() > MAX_TOKEN_LEN {
        return Err(ApiError::InvalidInput {
            message: "The bearer token exceeds the length limit".to_string(),
        });
    }
    Ok(token.to_string())
}

#[utoipa::path(
    get,
    path = "/api/auth/config",
    tag = "auth",
    responses(
        (status = 200, body = AuthConfigDto, description = "Sign-in mode probe; public in both run modes (loginUrl is null when disabled)"),
    )
)]
pub async fn get_auth_config(State(state): State<AppState>) -> Json<AuthConfigDto> {
    let enabled = state.auth.is_some();
    Json(AuthConfigDto {
        enabled,
        login_url: enabled.then(|| "/api/auth/oauth/start".to_string()),
    })
}

#[utoipa::path(
    get,
    path = "/api/auth/oauth/start",
    tag = "auth",
    params(
        ("finalUri" = String, Query, description = "Extension landing page: https://<32-char a–p id>.chromiumapp.org/"),
        ("handoffChallenge" = String, Query, description = "43-char base64url SHA-256 of the extension-held handoff verifier"),
    ),
    responses(
        (status = 302, description = "Redirect to the Herald authorize endpoint (S256 PKCE); sets the transaction cookie"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: malformed finalUri / handoffChallenge or unexpected parameters"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE: capacity or randomness failure"),
    )
)]
pub async fn oauth_start(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let Some(auth) = state.auth.as_ref() else {
        return Err(endpoint_not_found());
    };
    if query.len() != 2
        || !query.contains_key("finalUri")
        || !query.contains_key("handoffChallenge")
    {
        return Err(ApiError::InvalidInput {
            message: "Exactly the finalUri and handoffChallenge query parameters are expected"
                .to_string(),
        });
    }
    let final_uri = validate_final_uri(&query["finalUri"])?;
    if !is_base64url_43(&query["handoffChallenge"]) {
        return Err(ApiError::InvalidInput {
            message: "handoffChallenge must be 43 base64url characters".to_string(),
        });
    }

    let txn_id = random_hex_32()?;
    let oauth_state = random_hex_32()?;
    let code_verifier = hex::encode(random_bytes(64)?);
    let code_challenge = pkce_s256(&code_verifier);
    let now = auth.now();
    {
        let mut transient = auth.lock();
        transient.sweep_at(now);
        if transient.txns.len() >= STATE_CAPACITY {
            return Err(auth_unavailable());
        }
        transient.txns.insert(
            txn_id.clone(),
            OAuthTxn {
                state: oauth_state.clone(),
                code_verifier,
                final_uri,
                handoff_challenge: query["handoffChallenge"].clone(),
                expires_at: now + TXN_TTL,
            },
        );
    }

    let location = format!(
        "{}/api/oauth/{}/authorize?client_id={}&redirect_uri={}&response_type=code&state={}&code_challenge={}&code_challenge_method=S256",
        auth.config.base_url,
        urlencoding::encode(&auth.config.realm_id),
        urlencoding::encode(&auth.config.client_id),
        urlencoding::encode(&auth.config.redirect_uri),
        urlencoding::encode(&oauth_state),
        urlencoding::encode(&code_challenge),
    );
    Ok(redirect_response(
        location,
        vec![session_cookie(
            auth.cookie_name,
            &txn_id,
            TXN_TTL.as_secs(),
            auth.secure_cookie,
        )],
    ))
}

#[utoipa::path(
    get,
    path = "/api/auth/oauth/callback",
    tag = "auth",
    params(
        ("code" = Option<String>, Query, description = "Authorization code (absent when Herald reports an error)"),
        ("state" = Option<String>, Query, description = "Transaction state echoed by Herald"),
        ("error" = Option<String>, Query, description = "OAuth error code (snake_case, as sent by Herald)"),
        ("error_description" = Option<String>, Query, description = "Human-readable error detail"),
    ),
    responses(
        (status = 302, description = "Redirect to the validated finalUri carrying only #handoffCode=… (or #error=…); cookie cleared"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: missing/unknown/expired transaction cookie or unexpected parameters"),
    )
)]
pub async fn oauth_callback(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Some(auth) = state.auth.as_ref() else {
        return Err(endpoint_not_found());
    };
    // Unexpected parameters are rejected before anything is consumed.
    for (key, value) in &query {
        if !matches!(
            key.as_str(),
            "code" | "state" | "error" | "error_description"
        ) {
            return Ok(reject_with_cookie(
                "Unexpected query parameter",
                auth.cookie_name,
                auth.secure_cookie,
            ));
        }
        if value.len() > MAX_TOKEN_LEN {
            return Ok(reject_with_cookie(
                "Query parameter exceeds the length limit",
                auth.cookie_name,
                auth.secure_cookie,
            ));
        }
    }

    let txn_id = match cookie_value(&headers, auth.cookie_name) {
        Some(id) if is_hex_64(&id) => id,
        _ => {
            return Ok(reject_with_cookie(
                "A valid sign-in transaction cookie is required",
                auth.cookie_name,
                auth.secure_cookie,
            ))
        }
    };
    // Atomically consume the transaction: exactly one exchange per login, and replaying the
    // cookie finds nothing left.
    let txn = {
        let mut transient = auth.lock();
        transient.sweep_at(auth.now());
        transient.txns.remove(&txn_id)
    };
    let Some(txn) = txn else {
        return Ok(reject_with_cookie(
            "A valid sign-in transaction cookie is required",
            auth.cookie_name,
            auth.secure_cookie,
        ));
    };

    // The redirect target always comes from the server-stored transaction — the cookie only ever
    // carried the random id, and no request input can steer the redirect.
    let final_uri = txn.final_uri;
    let query_state = query.get("state").map(String::as_str).unwrap_or("");
    if !is_hex_64(query_state) || !constant_time_eq(query_state, &txn.state) {
        return Ok(handoff_error_redirect(
            &final_uri,
            "state_mismatch",
            "The sign-in session did not match; start sign-in again",
            auth.cookie_name,
            auth.secure_cookie,
        ));
    }

    if let Some(error_code) = query.get("error") {
        let description: String = query
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| "The sign-in attempt was rejected".to_string())
            .chars()
            .take(300)
            .collect();
        return Ok(handoff_error_redirect(
            &final_uri,
            &sanitize_error_code(error_code),
            &description,
            auth.cookie_name,
            auth.secure_cookie,
        ));
    }
    let Some(code) = query.get("code") else {
        return Ok(handoff_error_redirect(
            &final_uri,
            "oauth_error",
            "The sign-in attempt returned no authorization code",
            auth.cookie_name,
            auth.secure_cookie,
        ));
    };

    let token_url = format!(
        "{}/api/oauth/{}/token",
        auth.config.base_url,
        urlencoding::encode(&auth.config.realm_id)
    );
    let exchange = serde_json::json!({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": auth.config.redirect_uri,
        "client_id": auth.config.client_id,
        "code_verifier": txn.code_verifier,
    });
    let exchanged = match auth.http.post(&token_url).json(&exchange).send().await {
        Ok(response) if response.status().is_success() => {
            response.json::<OAuthTokenWire>().await.ok()
        }
        _ => None,
    };
    // A malformed token response fails the same way as a failed exchange: upstream details stay
    // server-side and the user sees one stable error code.
    let wire = exchanged.filter(|wire| {
        !wire.access_token.is_empty()
            && !wire.refresh_token.is_empty()
            && wire.token_type.eq_ignore_ascii_case("bearer")
            && wire.expires_in > 0
            && wire.refresh_expires_in > 0
    });
    let Some(wire) = wire else {
        return Ok(handoff_error_redirect(
            &final_uri,
            "token_exchange_failed",
            "Exchanging the authorization code failed; start sign-in again",
            auth.cookie_name,
            auth.secure_cookie,
        ));
    };

    let handoff_code = random_b64url_32()?;
    let now = auth.now();
    let stored = {
        let mut transient = auth.lock();
        transient.sweep_at(now);
        if transient.handoffs.len() >= STATE_CAPACITY {
            Err(())
        } else {
            transient.handoffs.insert(
                handoff_code.clone(),
                Handoff {
                    tokens: TokenSetDto {
                        access_token: wire.access_token,
                        refresh_token: wire.refresh_token,
                        expires_in: wire.expires_in,
                        refresh_expires_in: wire.refresh_expires_in,
                        token_type: "Bearer".to_string(),
                    },
                    handoff_challenge: txn.handoff_challenge,
                    issued_at: now,
                },
            );
            Ok(())
        }
    };
    if stored.is_err() {
        return Ok(handoff_error_redirect(
            &final_uri,
            "auth_unavailable",
            "The sign-in service is busy; try again shortly",
            auth.cookie_name,
            auth.secure_cookie,
        ));
    }

    // The fragment carries the handoff code only — never a token.
    Ok(redirect_response(
        format!("{final_uri}#handoffCode={handoff_code}"),
        vec![clear_cookie(auth.cookie_name, auth.secure_cookie)],
    ))
}

#[utoipa::path(
    post,
    path = "/api/auth/redeem",
    tag = "auth",
    request_body = RedeemTokenReq,
    responses(
        (status = 200, body = TokenSetDto, description = "Tokens delivered exactly once for a matching proof (no-store; TTLs are remaining seconds)"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: unknown/expired/already-used handoff code or wrong proof (one stable answer)"),
    )
)]
pub async fn redeem_token(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<RedeemTokenReq>,
) -> Result<NoStore<Json<TokenSetDto>>, ApiError> {
    let Some(auth) = state.auth.as_ref() else {
        return Err(endpoint_not_found());
    };
    if !is_base64url_43(&req.handoff_code) || !is_base64url_43(&req.handoff_verifier) {
        return Err(ApiError::InvalidInput {
            message: "handoffCode and handoffVerifier must be 43 base64url characters".to_string(),
        });
    }
    let presented = pkce_s256(&req.handoff_verifier);
    let now = auth.now();
    let redeemed = {
        let mut transient = auth.lock();
        transient.sweep_at(now);
        // Proof validation and removal share one short critical section: exactly one redemption
        // per handoff, and a wrong proof must not consume it.
        let matches = transient
            .handoffs
            .get(&req.handoff_code)
            .is_some_and(|handoff| constant_time_eq(&presented, &handoff.handoff_challenge));
        if matches {
            transient.handoffs.remove(&req.handoff_code)
        } else {
            None
        }
    };
    let Some(handoff) = redeemed else {
        // One stable answer for every failure mode: the caller must not learn which part failed.
        return Err(ApiError::InvalidInput {
            message: "The handoff code was rejected".to_string(),
        });
    };
    let elapsed = now
        .checked_duration_since(handoff.issued_at)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let access_left = handoff.tokens.expires_in - elapsed;
    let refresh_left = handoff.tokens.refresh_expires_in - elapsed;
    if access_left <= 0 || refresh_left <= 0 {
        return Err(ApiError::InvalidInput {
            message: "The handoff code was rejected".to_string(),
        });
    }
    Ok(NoStore(Json(TokenSetDto {
        access_token: handoff.tokens.access_token,
        refresh_token: handoff.tokens.refresh_token,
        expires_in: access_left,
        refresh_expires_in: refresh_left,
        token_type: handoff.tokens.token_type,
    })))
}

#[utoipa::path(
    post,
    path = "/api/auth/refresh",
    tag = "auth",
    request_body = RefreshTokenReq,
    responses(
        (status = 200, body = TokenSetDto, description = "Rotated token pair (no-store; nothing is stored server-side)"),
        (status = 400, body = ErrorBodyDto, description = "INVALID_INPUT: missing or oversized refreshToken"),
        (status = 401, body = ErrorBodyDto, description = "AUTH_REQUIRED: the refresh token was rejected — sign in again"),
        (status = 503, body = ErrorBodyDto, description = "AUTH_UNAVAILABLE"),
    )
)]
pub async fn refresh_token(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<RefreshTokenReq>,
) -> Result<NoStore<Json<TokenSetDto>>, ApiError> {
    let Some(auth) = state.auth.as_ref() else {
        return Err(endpoint_not_found());
    };
    if req.refresh_token.is_empty() || req.refresh_token.len() > MAX_TOKEN_LEN {
        return Err(ApiError::InvalidInput {
            message: "refreshToken must be 1–4096 characters".to_string(),
        });
    }
    let url = format!("{}/api/auth/browser-token/refresh", auth.config.base_url);
    let response = match auth
        .http
        .post(&url)
        .json(&serde_json::json!({ "refreshToken": req.refresh_token }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            tracing::debug!("herald refresh request failed: {err}");
            return Err(auth_unavailable());
        }
    };
    match response.status().as_u16() {
        200 => {
            let wire: RefreshWire = response.json().await.map_err(|_| auth_unavailable())?;
            if wire.access_token.is_empty()
                || wire.refresh_token.is_empty()
                || wire.expires_in <= 0
                || wire.refresh_expires_in <= 0
                || wire
                    .token_type
                    .as_deref()
                    .is_some_and(|kind| !kind.eq_ignore_ascii_case("bearer"))
            {
                return Err(auth_unavailable());
            }
            Ok(NoStore(Json(TokenSetDto {
                access_token: wire.access_token,
                refresh_token: wire.refresh_token,
                expires_in: wire.expires_in,
                refresh_expires_in: wire.refresh_expires_in,
                token_type: "Bearer".to_string(),
            })))
        }
        401 => Err(ApiError::AuthRequired),
        _ => Err(auth_unavailable()),
    }
}

/// Adds `Cache-Control: no-store` to a response carrying tokens.
pub struct NoStore<R>(pub R);

impl<R: IntoResponse> IntoResponse for NoStore<R> {
    fn into_response(self) -> Response {
        let mut response = self.0.into_response();
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

fn random_bytes(len: usize) -> Result<Vec<u8>, ApiError> {
    let mut buf = vec![0u8; len];
    getrandom::fill(&mut buf).map_err(|_| auth_unavailable())?;
    Ok(buf)
}

fn random_hex_32() -> Result<String, ApiError> {
    Ok(hex::encode(random_bytes(32)?))
}

fn random_b64url_32() -> Result<String, ApiError> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes(32)?))
}

/// RFC 7636 S256: base64url(SHA-256(verifier)) without padding — shared by the Herald PKCE
/// challenge and the handoff proof digest.
fn pkce_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// `https://<32-char a–p extension id>.chromiumapp.org/` — the exact shape Chrome mints for
/// launchWebAuthFlow. Anything else (userinfo, a non-default port, extra path, query, fragment,
/// suffix tricks) is rejected before a transaction is created. An explicit `:443` is the https
/// default port: `Url::parse` normalizes it away, so it passes and the raw string (still
/// same-origin) is kept as the redirect target.
fn validate_final_uri(raw: &str) -> Result<String, ApiError> {
    let invalid = || ApiError::InvalidInput {
        message: "finalUri must be https://<32-char a–p extension id>.chromiumapp.org/".to_string(),
    };
    if raw.len() > 200 {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    let valid = url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.host_str().is_some_and(|host| {
            host.len() == 32 + ".chromiumapp.org".len()
                && host.ends_with(".chromiumapp.org")
                && host.as_bytes()[..32]
                    .iter()
                    .all(|b| (b'a'..=b'p').contains(b))
        });
    if valid {
        Ok(raw.to_string())
    } else {
        Err(invalid())
    }
}

fn is_base64url_43(value: &str) -> bool {
    value.len() == HANDOFF_CODE_LEN
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_hex_64(value: &str) -> bool {
    value.len() == HEX_32_LEN && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Keeps only a safe, bounded token for the fragment error code; anything else collapses to a
/// generic label.
fn sanitize_error_code(code: &str) -> String {
    let safe = (1..=64).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
    if safe {
        code.to_string()
    } else {
        "oauth_error".to_string()
    }
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|header| header.split(';'))
        .find_map(|pair| {
            let (key, value) = pair.trim().split_once('=')?;
            (key == name).then(|| value.to_string())
        })
}

fn session_cookie(name: &str, value: &str, max_age: u64, secure: bool) -> String {
    // The __Host- prefix mandates exactly these attributes (Secure, Path=/, no Domain).
    if secure {
        format!("{name}={value}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax")
    } else {
        format!("{name}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax")
    }
}

fn clear_cookie(name: &str, secure: bool) -> String {
    session_cookie(name, "", 0, secure)
}

fn redirect_response(location: String, cookies: Vec<String>) -> Response {
    let mut response = (StatusCode::FOUND, [(LOCATION, location)]).into_response();
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            response.headers_mut().append(SET_COOKIE, value);
        }
    }
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// A 302 back to the validated finalUri with a fragment error (never tokens), clearing the
/// transaction cookie with its security attributes preserved.
fn handoff_error_redirect(
    final_uri: &str,
    code: &str,
    description: &str,
    cookie_name: &str,
    secure: bool,
) -> Response {
    redirect_response(
        format!(
            "{final_uri}#error={}&errorDescription={}",
            code,
            urlencoding::encode(description)
        ),
        vec![clear_cookie(cookie_name, secure)],
    )
}

/// A 400 JSON error that additionally clears the transaction cookie.
fn reject_with_cookie(message: &str, cookie_name: &str, secure: bool) -> Response {
    let mut response = ApiError::InvalidInput {
        message: message.to_string(),
    }
    .into_response();
    if let Ok(value) = HeaderValue::from_str(&clear_cookie(cookie_name, secure)) {
        response.headers_mut().append(SET_COOKIE, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn final_uri(id: &str) -> String {
        format!("https://{id}.chromiumapp.org/")
    }

    #[test]
    fn final_uri_accepts_only_the_chromiumapp_shape() {
        assert_eq!(
            validate_final_uri(&final_uri("abcdefghijklmnopabcdefghijklmnop")).unwrap(),
            final_uri("abcdefghijklmnopabcdefghijklmnop")
        );
        // An explicit :443 is the https default port — Url::parse normalizes it away, so the
        // check passes and the raw (same-origin) string is stored verbatim.
        let with_default_port =
            "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org:443/".to_string();
        assert_eq!(
            validate_final_uri(&with_default_port).unwrap(),
            with_default_port
        );
        for bad in [
            final_uri("qbcdefghijklmnopabcdefghijklmnop"), // 'q' outside a–p
            final_uri("abcdefghijklmnopabcdefghijklmno"),  // 31 chars
            "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback".to_string(),
            "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?x=1".to_string(),
            "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#f".to_string(),
            "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org:8443/".to_string(),
            "http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/".to_string(),
            "https://user:pass@abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/".to_string(),
            "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org.evil.example/".to_string(),
            "https://chromiumapp.org/".to_string(),
            "not a url".to_string(),
        ] {
            assert!(
                validate_final_uri(&bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn pkce_s256_matches_rfc7636_appendix_b_vector() {
        // RFC 7636 appendix B test vector.
        assert_eq!(
            pkce_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn shape_guards_for_codes_and_states() {
        let code = URL_SAFE_NO_PAD.encode([0u8; 32]);
        assert_eq!(code.len(), 43);
        assert!(is_base64url_43(&code));
        assert!(!is_base64url_43(&code[..42]));
        assert!(!is_base64url_43(&code.replace('A', "+")));
        assert!(is_hex_64(&"a".repeat(64)));
        assert!(!is_hex_64(&"a".repeat(63)));
        assert!(!is_hex_64(&"g".repeat(64)));
    }

    #[test]
    fn bearer_token_parsing_and_limits() {
        let mut headers = HeaderMap::new();
        assert!(matches!(
            bearer_token(&headers),
            Err(ApiError::AuthRequired)
        ));
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Basic abc"),
        );
        assert!(matches!(
            bearer_token(&headers),
            Err(ApiError::AuthRequired)
        ));
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer  "),
        );
        assert!(matches!(
            bearer_token(&headers),
            Err(ApiError::AuthRequired)
        ));
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer t.ok"),
        );
        assert_eq!(bearer_token(&headers).unwrap(), "t.ok");
        // Whitespace around the token (double space after the scheme / trailing space) must
        // not survive into the forwarded value — Herald rejects the padded token.
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer  t.ok"),
        );
        assert_eq!(bearer_token(&headers).unwrap(), "t.ok");
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str("Bearer t.ok ").unwrap(),
        );
        assert_eq!(bearer_token(&headers).unwrap(), "t.ok");
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", "x".repeat(4097))).unwrap(),
        );
        assert!(matches!(
            bearer_token(&headers),
            Err(ApiError::InvalidInput { .. })
        ));
    }

    #[test]
    fn cookie_extraction_and_attributes() {
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_static("other=1; OW_SYNC_OAUTH=abc; more=2"),
        );
        assert_eq!(
            cookie_value(&headers, "OW_SYNC_OAUTH").as_deref(),
            Some("abc")
        );
        assert_eq!(cookie_value(&headers, "missing"), None);

        assert_eq!(
            session_cookie("__Host-OW_SYNC_OAUTH", "v", 300, true),
            "__Host-OW_SYNC_OAUTH=v; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax"
        );
        assert_eq!(
            session_cookie("OW_SYNC_OAUTH", "v", 300, false),
            "OW_SYNC_OAUTH=v; Path=/; Max-Age=300; HttpOnly; SameSite=Lax"
        );
        assert_eq!(
            clear_cookie("OW_SYNC_OAUTH", false),
            "OW_SYNC_OAUTH=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
        );
    }

    #[test]
    fn error_code_sanitization() {
        assert_eq!(sanitize_error_code("access_denied"), "access_denied");
        assert_eq!(sanitize_error_code("bad code"), "oauth_error");
        assert_eq!(sanitize_error_code(""), "oauth_error");
        assert_eq!(sanitize_error_code(&"x".repeat(65)), "oauth_error");
        assert_eq!(sanitize_error_code("access\r\ndenied"), "oauth_error");
    }
}
