use std::sync::Arc;

use sqlx::PgPool;

use crate::{config::Config, translation_pool::TranslationPools};

pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub translation_pools: Option<Arc<TranslationPools>>,
}
