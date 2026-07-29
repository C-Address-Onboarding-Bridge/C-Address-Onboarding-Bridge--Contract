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
use tokio_util::sync::CancellationToken;
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub db: db::Database,
    pub rpc_url: String,
    pub contract_id: String,
    pub webhook_client: reqwest::Client,
    /// Number of ledgers to look back from the RPC tip on first run (no
    /// persisted `last_ledger`).  Set via `LOOKBACK_LEDGERS` env var
    /// (default: 720 ≈ 1 hour at ~5 s/ledger).
    ///
    /// # Backfill procedure
    ///
    /// Soroban RPC nodes retain only a limited history window (≈ 17 280
    /// ledgers / 24 h on mainnet).  Requesting `startLedger=0` is rejected
    /// by any real endpoint.  If you need events older than the RPC retains:
    ///
    /// 1. Point `SOROBAN_RPC_URL` at an archive node that holds the history
    ///    you need (e.g. a `stellar-core` instance with full catchup).
    /// 2. Set `LOOKBACK_LEDGERS` to cover the range you want and start the
    ///    indexer — it will fast-forward from the historical ledger to the
    ///    current tip, persisting every event along the way.
    /// 3. Once caught up, switch `SOROBAN_RPC_URL` back to your normal RPC;
    ///    the persisted `last_ledger` cursor keeps it in sync from there.
    ///
    /// Note: `POST /api/replay` **only re-delivers already-indexed events**
    /// to webhooks — it does not fetch new history from the chain.
    pub lookback_ledgers: i64,
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
    let lookback_ledgers: i64 = std::env::var("LOOKBACK_LEDGERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(poller::DEFAULT_LOOKBACK_LEDGERS);

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
        lookback_ledgers,
    });

    // Cancellation token shared across all background tasks. When triggered,
    // the poller and webhook worker finish their current iteration and exit
    // cleanly before the axum server drains in-flight HTTP requests.
    let token = CancellationToken::new();

    let poller_state = Arc::clone(&state);
    let poller_token = token.clone();
    let poller_handle = tokio::spawn(async move {
        poller::run_poller(poller_state, poller_token).await;
    });

    let webhook_state = Arc::clone(&state);
    let webhook_token = token.clone();
    let webhook_handle = tokio::spawn(async move {
        webhook::run_delivery_worker(webhook_state, webhook_token).await;
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

    // Shutdown signal: wait for SIGTERM or SIGINT, then cancel background tasks.
    let shutdown_token = token.clone();
    let shutdown_signal = async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
            let mut sigint = signal(SignalKind::interrupt()).expect("failed to install SIGINT handler");
            tokio::select! {
                _ = sigterm.recv() => tracing::info!("Received SIGTERM"),
                _ = sigint.recv()  => tracing::info!("Received SIGINT"),
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c().await.expect("failed to listen for ctrl-c");
            tracing::info!("Received ctrl-c");
        }

        // Signal background tasks to stop after their current iteration.
        shutdown_token.cancel();
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal)
        .await
        .unwrap();

    // Wait for background tasks to finish their current iteration.
    let _ = tokio::join!(poller_handle, webhook_handle);
    tracing::info!("Indexer shut down cleanly");
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
) -> Result<(StatusCode, Json<webhook::Subscription>), (StatusCode, Json<serde_json::Value>)> {
    // Validate the URL before persisting to prevent SSRF via webhook delivery.
    if let Err(e) = webhook::validate_webhook_url(&req.url) {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": e.to_string() })),
        ));
    }

    state
        .db
        .create_subscription(req)
        .await
        .map(|s| (StatusCode::CREATED, Json(s)))
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "database error" })),
            )
        })
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
