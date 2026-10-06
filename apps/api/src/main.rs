mod data_routes;
mod routes;
use axum::{
    Router,
    routing::{get, post},
};
use data_agent::{modules::access::DevelopmentIdentity, persistence};
use sqlx::MySqlPool;
use std::{env, sync::Arc};
#[derive(Clone)]
pub struct State {
    pub pool: MySqlPool,
    pub identities: DevelopmentIdentity,
    pub internal_token: Arc<String>,
    pub model_profile: Option<data_agent::contracts::generated::ModelProfile>,
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = State {
        pool: persistence::connect(&env::var("DATA_AGENT_DATABASE_URL")?).await?,
        identities: DevelopmentIdentity::from_config(
            &env::var("DATA_AGENT_MODE")?,
            &env::var("DATA_AGENT_DEV_IDENTITIES")?,
        )?,
        internal_token: Arc::new(env::var("DATA_AGENT_INTERNAL_TOKEN")?),
        model_profile: env::var("DATA_AGENT_MODEL_PROFILE")
            .ok()
            .map(|text| {
                let value = serde_json::from_str(&text)
                    .map_err(|_| data_agent::types::Error::new("invalid_input"))?;
                data_agent::contracts::decode("ModelProfile", value)
            })
            .transpose()?,
    };
    if state.internal_token.len() < 32 {
        return Err("internal token too short".into());
    }
    if let Some(profile) = &state.model_profile {
        data_agent::modules::runtime::configure_trial(&state.pool, profile).await?;
    }
    data_agent::use_cases::knowledge::initialize(&state.pool).await?;
    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/session",
            post(routes::login)
                .get(routes::identity)
                .delete(routes::logout),
        )
        .route("/conversations", post(routes::create).get(routes::history))
        .route(
            "/conversations/{id}",
            axum::routing::delete(data_routes::delete_conversation),
        )
        .route(
            "/conversations/{id}/tasks/{task}/cancel",
            post(data_routes::cancel_task),
        )
        .route(
            "/conversations/{id}/messages/{message}/withdraw",
            post(data_routes::withdraw),
        )
        .route("/conversations/{id}/messages", post(routes::message))
        .route("/conversations/{id}/cancel-run", post(routes::cancel_run))
        .route("/conversations/{id}/snapshot", get(routes::snapshot))
        .route("/conversations/{id}/events", get(routes::events))
        .route("/internal/tool-calls", post(routes::register))
        .route("/internal/tools", post(routes::tool))
        .route("/internal/outputs", post(routes::output))
        .route("/internal/finish", post(routes::finish))
        .route("/internal/checkpoints/read", post(routes::read_checkpoint))
        .route(
            "/internal/memory/model-calls",
            post(data_routes::memory_model_call),
        )
        .route("/internal/model/issue", post(routes::issue))
        .route("/internal/model/settle", post(routes::settle))
        .route("/internal/model/reserve", post(routes::reserve_model))
        .route("/internal/model/send", post(routes::send_model))
        .route("/internal/model/finalize", post(routes::finalize_model))
        .route(
            "/knowledge",
            get(data_routes::knowledge).post(data_routes::create_knowledge),
        )
        .route(
            "/knowledge/{id}",
            get(data_routes::read_knowledge).patch(data_routes::edit_knowledge),
        )
        .route(
            "/knowledge/{id}/{action}",
            post(data_routes::knowledge_action),
        )
        .route(
            "/knowledge/{id}/analysis-preference",
            post(data_routes::analysis_preference),
        )
        .route("/sources/{id}", get(data_routes::source))
        .route("/source-syncs", post(data_routes::sync))
        .route(
            "/knowledge-index/rebuilds",
            post(data_routes::rebuild_index),
        )
        .route(
            "/assets",
            get(data_routes::assets).post(data_routes::save_asset),
        )
        .route("/assets/{id}/{action}", post(data_routes::asset_action))
        .route(
            "/conversations/{id}/skill-selections",
            post(data_routes::select_skill),
        )
        .route("/conversations/{id}/queries", get(data_routes::queries))
        .route("/queries/{id}", get(data_routes::query))
        .route("/queries/{id}/confirm", post(data_routes::confirm))
        .route("/queries/{id}/cancel", post(data_routes::cancel))
        .route("/queries/{id}/results", get(data_routes::results))
        .route("/queries/{id}/export.csv", get(data_routes::export))
        .route("/knowledge-proposals", get(data_routes::proposals))
        .route(
            "/knowledge-proposals/{id}/apply",
            post(data_routes::apply_proposal),
        )
        .route("/internal/data/tool-calls", post(data_routes::register))
        .route("/internal/data/tools", post(data_routes::tool))
        .route(
            "/internal/data/tool-rejections",
            post(data_routes::tool_rejection),
        )
        .layer(axum::extract::DefaultBodyLimit::max(512 * 1024))
        .with_state(state);
    let port = env::var("DATA_AGENT_API_PORT")?.parse::<u16>()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    eprintln!("api_started port={port} mode=development");
    axum::serve(listener, router).await?;
    Ok(())
}
