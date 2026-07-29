mod db;
mod events;
mod poller;
mod webhook;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    routing::{delete, get, post},
    Json, Router,
};
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub db: db::Database,
    pub rpc_url: String,
    pub contract_id: String,
    pub webhook_client: reqwest::Client,
    /// SHA-256 hex digest of the raw API key, so the plaintext never lives in
    /// memory beyond the single comparison at startup.
    pub api_key_hash: String,
}

// ---------------------------------------------------------------------------
// Auth middleware — Bearer token checked against API_KEY env var
// ---------------------------------------------------------------------------

/// Axum middleware that rejects requests without a valid `Authorization: Bearer <key>` header.
///
/// The expected key is read once from the `API_KEY` environment variable at startup
/// and stored as its SHA-256 hash in `AppState` so the plaintext is not retained.
/// Requests carrying the wrong or missing token receive **401 Unauthorized**.
async fn require_api_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Result<axum::response::Response, StatusCode> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    let digest = sha256_hex(token);
    if digest != state.api_key_hash {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(request).await)
}

/// Compute the SHA-256 hex digest of `input` using only stdlib.
fn sha256_hex(input: &str) -> String {
    use std::fmt::Write as _;
    // SHA-256 in pure Rust via the ring-free approach — use the `sha2` crate
    // when available; here we rely on the OS via `std::hash` is not available,
    // so we use a small hand-rolled wrapper around the ring-independent
    // `sha2` computation already pulled in transitively through `hex` + `base64`.
    // Since this crate only has `hex` and `base64` as crypto-adjacent deps,
    // we implement a minimal SHA-256 using the `openssl`-free path:
    // delegate to the `sha256` function from the `sha2` crate.  If that crate
    // is not in Cargo.toml we fall back to a simple constant-time comparison
    // using a pre-hashed sentinel — but for production correctness we add
    // `sha2` as a dependency (see Cargo.toml change below).
    //
    // For now we use the `ring`-free pure-Rust implementation already available
    // through `hex`/`base64` without adding a new dep by using a simple
    // wrapper over the standard library's `std::collections::hash_map` — which
    // is NOT cryptographic.  Therefore we add `sha2` to Cargo.toml.
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in result {
        write!(out, "{:02x}", byte).unwrap();
    }
    out
}

/// Build the CorsLayer from the `CORS_ALLOWED_ORIGINS` env var.
///
/// `CORS_ALLOWED_ORIGINS` is a comma-separated list of origins, e.g.:
///   `https://dashboard.example.com,https://admin.example.com`
///
/// If the variable is absent or empty, CORS is disabled (no `Access-Control-Allow-Origin`
/// header is sent) rather than defaulting to permissive.
fn build_cors_layer() -> CorsLayer {
    let raw = std::env::var("CORS_ALLOWED_ORIGINS").unwrap_or_default();
    let origins: Vec<axum::http::HeaderValue> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();

    if origins.is_empty() {
        // No origins configured — return a layer that never adds the header.
        CorsLayer::new()
    } else {
        CorsLayer::new().allow_origin(AllowOrigin::list(origins))
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("bridge_indexer=info".parse().unwrap()))
        .init();

    let rpc_url = std::env::var("STELLAR_RPC_URL")
        .or_else(|_| std::env::var("SOROBAN_RPC_URL"))
        .unwrap_or_else(|_| "https://soroban-testnet.stellar.org".to_string());
    let contract_id = std::env::var("CONTRACT_ID").expect("CONTRACT_ID must be set");
    let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:indexer.db".to_string());
    let listen_addr = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:3001".to_string());

    // Hash the API key once at startup so the plaintext is not retained in memory.
    let api_key_raw = std::env::var("API_KEY").expect("API_KEY must be set");
    let api_key_hash = sha256_hex(&api_key_raw);
    drop(api_key_raw); // discard the plaintext immediately

    let database = db::Database::new(&db_url).await;
    database.migrate().await;

    let state = Arc::new(AppState {
        db: database,
        rpc_url,
        contract_id,
        webhook_client: reqwest::Client::new(),
        api_key_hash,
    });

    let poller_state = Arc::clone(&state);
    tokio::spawn(async move {
        poller::run_poller(poller_state).await;
    });

    let webhook_state = Arc::clone(&state);
    tokio::spawn(async move {
        webhook::run_delivery_worker(webhook_state).await;
    });

    // Public read-only routes — no auth required.
    let public_routes = Router::new()
        .route("/api/events", get(list_events))
        .route("/api/events/:event_type", get(list_events_by_type))
        .route("/api/subscriptions", get(list_subscriptions))
        .route("/api/stats", get(get_stats))
        .route("/health", get(health));

    // Mutating routes — require a valid API key.
    let protected_routes = Router::new()
        .route("/api/subscriptions", post(create_subscription))
        .route("/api/subscriptions/:id", delete(delete_subscription))
        .route("/api/replay", post(replay_events))
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_api_key,
        ));

    let app = public_routes
        .merge(protected_routes)
        .layer(build_cors_layer())
        .with_state(state);

    tracing::info!("Indexer listening on {}", listen_addr);
    let listener = tokio::net::TcpListener::bind(&listen_addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> &'static str {
    "ok"
}

async fn list_events(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<events::EventQuery>,
) -> Result<Json<Vec<events::IndexedEvent>>, StatusCode> {
    state
        .db
        .list_events(params.limit.unwrap_or(50), params.offset.unwrap_or(0))
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn list_events_by_type(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(event_type): axum::extract::Path<String>,
    axum::extract::Query(params): axum::extract::Query<events::EventQuery>,
) -> Result<Json<Vec<events::IndexedEvent>>, StatusCode> {
    state
        .db
        .list_events_by_type(&event_type, params.limit.unwrap_or(50), params.offset.unwrap_or(0))
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn create_subscription(
    State(state): State<Arc<AppState>>,
    Json(req): Json<webhook::CreateSubscription>,
) -> Result<(StatusCode, Json<webhook::Subscription>), StatusCode> {
    state
        .db
        .create_subscription(req)
        .await
        .map(|s| (StatusCode::CREATED, Json(s)))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn list_subscriptions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<webhook::Subscription>>, StatusCode> {
    state
        .db
        .list_subscriptions()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn delete_subscription(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> StatusCode {
    match state.db.delete_subscription(&id).await {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn replay_events(
    State(state): State<Arc<AppState>>,
    Json(req): Json<webhook::ReplayRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let events = state
        .db
        .list_events_from_ledger(req.from_ledger, req.limit.unwrap_or(100))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let count = events.len();
    for event in events {
        state
            .db
            .queue_webhook_deliveries(&event)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    Ok(Json(serde_json::json!({ "replayed": count })))
}

async fn get_stats(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    state
        .db
        .get_stats()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// ---------------------------------------------------------------------------
// Auth middleware tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod auth_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt; // for `oneshot`

    /// Build a minimal app wired with the same auth middleware used in main(),
    /// backed by an in-memory SQLite database so no file system state is needed.
    async fn test_app(api_key: &str) -> Router {
        let database = db::Database::new("sqlite::memory:").await;
        database.migrate().await;

        let state = Arc::new(AppState {
            db: database,
            rpc_url: "http://localhost".to_string(),
            contract_id: "C_TEST".to_string(),
            webhook_client: reqwest::Client::new(),
            api_key_hash: sha256_hex(api_key),
        });

        let public_routes = Router::new()
            .route("/api/subscriptions", get(list_subscriptions))
            .route("/health", get(health));

        let protected_routes = Router::new()
            .route("/api/subscriptions", post(create_subscription))
            .route("/api/subscriptions/:id", delete(delete_subscription))
            .route("/api/replay", post(replay_events))
            .route_layer(middleware::from_fn_with_state(
                Arc::clone(&state),
                require_api_key,
            ));

        public_routes
            .merge(protected_routes)
            .with_state(state)
    }

    #[tokio::test]
    async fn test_unauthenticated_post_subscription_is_rejected() {
        let app = test_app("secret-key").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/subscriptions")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"url":"http://example.com","event_types":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "POST /api/subscriptions without token must return 401"
        );
    }

    #[tokio::test]
    async fn test_wrong_api_key_is_rejected() {
        let app = test_app("secret-key").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/subscriptions")
                    .header("Authorization", "Bearer wrong-key")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"url":"http://example.com","event_types":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "POST /api/subscriptions with wrong token must return 401"
        );
    }

    #[tokio::test]
    async fn test_correct_api_key_is_accepted() {
        let app = test_app("secret-key").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/subscriptions")
                    .header("Authorization", "Bearer secret-key")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"url":"http://example.com","event_types":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "POST /api/subscriptions with correct token must not return 401"
        );
    }

    #[tokio::test]
    async fn test_unauthenticated_delete_subscription_is_rejected() {
        let app = test_app("secret-key").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/subscriptions/some-id")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "DELETE /api/subscriptions/:id without token must return 401"
        );
    }

    #[tokio::test]
    async fn test_unauthenticated_replay_is_rejected() {
        let app = test_app("secret-key").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/replay")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"from_ledger":1}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "POST /api/replay without token must return 401"
        );
    }

    #[tokio::test]
    async fn test_public_routes_do_not_require_auth() {
        let app = test_app("secret-key").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "GET /health must be publicly accessible"
        );
    }

    #[tokio::test]
    async fn test_sha256_hex_is_consistent() {
        // Same input must always produce the same digest.
        assert_eq!(sha256_hex("hello"), sha256_hex("hello"));
        // Different inputs must produce different digests.
        assert_ne!(sha256_hex("hello"), sha256_hex("world"));
        // Output is 64 hex chars (32 bytes).
        assert_eq!(sha256_hex("test").len(), 64);
    }
}
