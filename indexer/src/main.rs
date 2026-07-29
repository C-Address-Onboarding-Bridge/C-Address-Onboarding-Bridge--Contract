mod db;
mod events;
mod poller;
mod webhook;

use axum::{
    extract::State,
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use std::sync::Arc;
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

    let database = db::Database::new(&db_url).await;
    database.migrate().await;

    let state = Arc::new(AppState {
        db: database,
        rpc_url,
        contract_id,
        webhook_client: reqwest::Client::new(),
        lookback_ledgers,
    });

    let poller_state = Arc::clone(&state);
    tokio::spawn(async move {
        poller::run_poller(poller_state).await;
    });

    let webhook_state = Arc::clone(&state);
    tokio::spawn(async move {
        webhook::run_delivery_worker(webhook_state).await;
    });

    let app = Router::new()
        .route("/api/events", get(list_events))
        .route("/api/events/:event_type", get(list_events_by_type))
        .route("/api/subscriptions", post(create_subscription))
        .route("/api/subscriptions", get(list_subscriptions))
        .route("/api/subscriptions/:id", delete(delete_subscription))
        .route("/api/replay", post(replay_events))
        .route("/api/stats", get(get_stats))
        .route("/health", get(health))
        .layer(CorsLayer::permissive())
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
