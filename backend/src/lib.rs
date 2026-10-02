// The lib target lets tests/ integration tests reach AppState and the router assembly (a bin target
// cannot be imported by integration tests).

pub mod config;
pub mod db;
pub mod dto;
pub mod error;
pub mod openapi;
pub mod routes;
pub mod spacekey;

use sqlx::PgPool;

/// Carries only the connection pool: access control queries the database per request, the service
/// keeps no in-memory state.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
}
