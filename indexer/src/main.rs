mod db;
mod events;
mod poller;
mod webhook;

use axum::{
    extract::State,
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub db: db::Database,
    pub rpc_url: String,
    pub contract_id: String,
    /// HTTP client used for Soroban RPC calls, built with the timeouts
    /// configured below so a hung RPC node cannot stall the poll loop
    /// indefinitely (#638).
    pub rpc_client: reqwest::Client,
    pub webhook_client: reqwest::Client,
    pub api_key_hash: String,
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

pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/events", get(list_events))
        .route("/api/events/:event_type", get(list_events_by_type))
        .route("/api/stats", get(get_stats))
        .route("/health", get(health))
}

pub fn protected_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/subscriptions",
            get(list_subscriptions).post(create_subscription),
        )
        .route("/api/subscriptions/:id", delete(delete_subscription))
        .route("/api/replay", post(replay_events))
}

pub fn build_app(state: Arc<AppState>) -> Router {
    let protected = protected_routes().route_layer(middleware::from_fn_with_state(
        Arc::clone(&state),
        require_api_key,
    ));

    public_routes()
        .merge(protected)
        .layer(build_cors_layer())
        .with_state(state)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("bridge_indexer=info".parse().unwrap()),
        )
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

    let api_key_raw = std::env::var("API_KEY").expect("API_KEY must be set");
    assert!(!api_key_raw.is_empty(), "API_KEY must not be empty");
    let api_key_hash = sha256_hex(&api_key_raw);
    drop(api_key_raw);

    let database = db::Database::new(&db_url).await;
    database.migrate().await;

    // Build a dedicated RPC client with timeouts so a hung RPC node cannot
    // stall the poll loop indefinitely (#638).
    let rpc_connect_timeout_secs: u64 = std::env::var("RPC_CONNECT_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    let rpc_request_timeout_secs: u64 = std::env::var("RPC_REQUEST_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let rpc_client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(rpc_connect_timeout_secs))
        .timeout(std::time::Duration::from_secs(rpc_request_timeout_secs))
        .build()
        .expect("failed to build RPC HTTP client");

    // Webhook client: never follow redirects (a 3xx is treated as a delivery
    // failure) so a validated URL cannot be bounced to an internal address
    // (#870).  Per-request DNS pinning to the vetted IP happens in
    // `webhook::deliver`.
    let webhook_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("failed to build webhook HTTP client");

    let state = Arc::new(AppState {
        db: database,
        rpc_url,
        contract_id,
        rpc_client,
        webhook_client,
        api_key_hash,
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

    let app = build_app(state);

    tracing::info!("Indexer listening on {}", listen_addr);
    let listener = tokio::net::TcpListener::bind(&listen_addr).await.unwrap();

    // Shutdown signal: wait for SIGTERM or SIGINT, then cancel background tasks.
    let shutdown_token = token.clone();
    let shutdown_signal = async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm =
                signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
            let mut sigint =
                signal(SignalKind::interrupt()).expect("failed to install SIGINT handler");
            tokio::select! {
                _ = sigterm.recv() => tracing::info!("Received SIGTERM"),
                _ = sigint.recv()  => tracing::info!("Received SIGINT"),
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c()
                .await
                .expect("failed to listen for ctrl-c");
            tracing::info!("Received ctrl-c");
        }

        // Signal background tasks to stop after their current iteration.
        shutdown_token.cancel();
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal)
        .await
        .unwrap();

    // `with_graceful_shutdown` above already cancelled `token` once SIGTERM/
    // SIGINT arrived, so both workers are winding down (or already have).
    // Join them so `main` does not return -- and the process does not exit --
    // until they have actually stopped. See #646.
    let _ = tokio::join!(poller_handle, webhook_handle);
    tracing::info!("Indexer shut down cleanly");
}

fn build_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

async fn require_api_key(
    State(state): State<Arc<AppState>>,
    request: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    let provided_key = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value.strip_prefix("Bearer ").map(str::to_owned)
        });

    let authorized = match provided_key {
        Some(key) => {
            let provided_hash = sha256_hex(&key);
            provided_hash
                .as_bytes()
                .ct_eq(state.api_key_hash.as_bytes())
                .into()
        }
        None => false,
    };

    if authorized {
        next.run(request).await
    } else {
        (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
    }
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn list_events(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<EventQuery>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(50).min(500);
    let offset = params.offset.unwrap_or(0);
    match state.db.list_events(limit, offset).await {
        Ok(events) => Json(events).into_response(),
        Err(e) => {
            tracing::error!("failed to list events: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

async fn list_events_by_type(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(event_type): axum::extract::Path<String>,
    axum::extract::Query(params): axum::extract::Query<EventQuery>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(50).min(500);
    let offset = params.offset.unwrap_or(0);
    match state
        .db
        .list_events_by_type(&event_type, limit, offset)
        .await
    {
        Ok(events) => Json(events).into_response(),
        Err(e) => {
            tracing::error!("failed to list events by type: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

async fn get_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.db.get_stats().await {
        Ok(stats) => Json(stats).into_response(),
        Err(e) => {
            tracing::error!("failed to get stats: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

async fn list_subscriptions(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.db.list_subscriptions().await {
        Ok(subs) => Json(subs).into_response(),
        Err(e) => {
            tracing::error!("failed to list subscriptions: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

async fn create_subscription(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateSubscriptionBody>,
) -> impl IntoResponse {
    if let Err(reason) = webhook::validate_webhook_url(&body.url).await {
        return (StatusCode::BAD_REQUEST, reason).into_response();
    }

    match state
        .db
        .create_subscription(&body.url, &body.event_types)
        .await
    {
        Ok(sub) => (StatusCode::CREATED, Json(sub)).into_response(),
        Err(e) => {
            tracing::error!("failed to create subscription: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

async fn delete_subscription(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> impl IntoResponse {
    match state.db.delete_subscription(id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, "not found").into_response(),
        Err(e) => {
            tracing::error!("failed to delete subscription: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

async fn replay_events(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ReplayBody>,
) -> impl IntoResponse {
    match state.db.enqueue_replay(&body.event_ids).await {
        Ok(count) => Json(serde_json::json!({ "enqueued": count })).into_response(),
        Err(e) => {
            tracing::error!("failed to enqueue replay: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

#[derive(serde::Deserialize)]
struct EventQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(serde::Deserialize)]
struct CreateSubscriptionBody {
    url: String,
    #[serde(default)]
    event_types: Vec<String>,
}

#[derive(serde::Deserialize)]
struct ReplayBody {
    event_ids: Vec<i64>,
}
