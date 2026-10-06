use crate::types::{AccessContext, Error, Result, id};
use std::collections::HashMap;

#[derive(Clone)]
pub struct DevelopmentIdentity {
    tokens: HashMap<String, AccessContext>,
}
impl DevelopmentIdentity {
    pub fn from_config(mode: &str, config: &str) -> Result<Self> {
        if mode != "development" {
            return Err(Error::new("unauthenticated"));
        }
        let source: HashMap<String, String> =
            serde_json::from_str(config).map_err(|_| Error::new("invalid_input"))?;
        if source.len() < 2 || source.keys().any(|k| k.len() < 32) {
            return Err(Error::new("invalid_input"));
        }
        let tokens = source
            .into_iter()
            .map(|(token, user_id)| {
                (
                    token,
                    AccessContext {
                        user_id,
                        space_id: "demo".into(),
                        request_id: id(),
                    },
                )
            })
            .collect();
        Ok(Self { tokens })
    }
    pub fn resolve(&self, token: &str) -> Result<AccessContext> {
        let mut context = self
            .tokens
            .get(token)
            .cloned()
            .ok_or(Error::new("unauthenticated"))?;
        context.request_id = id();
        Ok(context)
    }
}
pub fn authorize_owner(context: &AccessContext, owner_id: &str, space_id: &str) -> Result<()> {
    if context.user_id != owner_id || context.space_id != space_id {
        return Err(Error::new("not_available"));
    }
    Ok(())
}
pub fn authorize_model(profile: &str) -> Result<()> {
    if profile != "local_mock" && profile != "deepseek" && profile != "bailian" {
        return Err(Error::new("not_available"));
    }
    Ok(())
}
// 角色仅由可信部署配置提供；浏览器身份与模型参数不能授予角色。
pub fn is_super_maintainer(ctx: &AccessContext) -> Result<bool> {
    let config =
        std::env::var("DATA_AGENT_SEMANTIC_SUPER_MAINTAINERS").unwrap_or_else(|_| "{}".into());
    let roles: HashMap<String, Vec<String>> =
        serde_json::from_str(&config).map_err(|_| Error::new("invalid_input"))?;
    Ok(roles
        .get(&ctx.space_id)
        .is_some_and(|users| users.contains(&ctx.user_id)))
}
pub fn authorize_maintainer(ctx: &AccessContext) -> Result<()> {
    if is_super_maintainer(ctx)? {
        Ok(())
    } else {
        Err(Error::new("forbidden"))
    }
}
mod store;
pub use store::{
    assign_in_tx, authorize_semantic_in_tx, maintainable_ids_in_tx, maintenance_in_tx,
    register_in_tx, sync_maintainer_in_tx,
};
