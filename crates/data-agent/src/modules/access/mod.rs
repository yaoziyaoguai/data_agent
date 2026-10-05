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
    if profile != "local_mock" && profile != "deepseek" {
        return Err(Error::new("not_available"));
    }
    Ok(())
}
// 开发空间固定两种角色；接入真实身份平台时由适配器提供角色证明。
pub fn authorize_maintainer(ctx: &AccessContext) -> Result<()> {
    if ctx.space_id == "demo" && ctx.user_id == "alice" {
        Ok(())
    } else {
        Err(Error::new("forbidden"))
    }
}
