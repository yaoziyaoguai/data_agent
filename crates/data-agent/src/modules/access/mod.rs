use crate::types::{AccessContext, Error, Result, id};
use std::{collections::HashMap, sync::OnceLock};

// 空间显示名只作界面呈现，来源限定为部署配置；不参与授权，避免浏览器身份注入。
fn space_name_cell() -> &'static str {
    static CELL: OnceLock<String> = OnceLock::new();
    CELL.get_or_init(|| {
        std::env::var("DATA_AGENT_SPACE_NAME")
            .ok()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "合成座舱语音空间".into())
    })
}
pub fn space_name() -> &'static str {
    space_name_cell()
}

#[derive(Clone)]
pub struct DevelopmentIdentity {
    tokens: HashMap<String, AccessContext>,
}
pub struct SpaceMembers {
    space_id: String,
    user_ids: Vec<String>,
}
impl SpaceMembers {
    pub fn user_ids(&self, context: &AccessContext) -> Result<&[String]> {
        if self.space_id != context.space_id {
            return Err(Error::new("not_available"));
        }
        Ok(&self.user_ids)
    }
    pub fn require_member(&self, context: &AccessContext, member: Option<&str>) -> Result<()> {
        let users = self.user_ids(context)?;
        if member.is_some_and(|id| !users.iter().any(|user| user == id)) {
            return Err(Error::new("invalid_input"));
        }
        Ok(())
    }
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
                        table_access: None,
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
    pub fn members(&self, context: &AccessContext) -> SpaceMembers {
        // 与登录复用同一可信目录；令牌不进入成员响应。
        let mut users: Vec<_> = self
            .tokens
            .values()
            .filter(|member| member.space_id == context.space_id)
            .map(|member| member.user_id.clone())
            .collect();
        users.sort();
        users.dedup();
        SpaceMembers {
            space_id: context.space_id.clone(),
            user_ids: users,
        }
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
// 解析结果进程级缓存：环境变量为进程静态，逐请求不再重复反序列化；
// 解析失败不缓存，原始错误码逐次返回，修复配置后无需重启。
fn super_maintainers() -> Result<&'static HashMap<String, Vec<String>>> {
    static ROLES: OnceLock<HashMap<String, Vec<String>>> = OnceLock::new();
    if let Some(roles) = ROLES.get() {
        return Ok(roles);
    }
    let config =
        std::env::var("DATA_AGENT_SEMANTIC_SUPER_MAINTAINERS").unwrap_or_else(|_| "{}".into());
    let roles: HashMap<String, Vec<String>> =
        serde_json::from_str(&config).map_err(|_| Error::new("invalid_input"))?;
    Ok(ROLES.get_or_init(|| roles))
}
pub fn is_super_maintainer(ctx: &AccessContext) -> Result<bool> {
    Ok(super_maintainers()?
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
    assign_in_tx, authorize_semantic_in_tx, can_create_in_tx, can_create_snapshot_in_tx,
    create_session_in_tx, has_maintenance_snapshot_in_tx, maintainable_ids_in_tx,
    maintenance_in_tx, maintenance_snapshot_in_tx, prune_sessions, register_batch_in_tx,
    register_creator_in_tx, register_in_tx, resolve_session, revoke_session_in_tx,
    sync_maintainer_in_tx,
};

// 会话令牌：256位随机数十六进制下发，库中只存其SHA-256摘要；库泄露不等于
// Cookie可伪造。
pub fn issue_session_token() -> Result<String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::new("unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
pub fn session_token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

// 模型接入配置是独立管理操作，显式使用本空间可信超级管理员身份。
pub fn authorize_model_configuration(ctx: &AccessContext) -> Result<()> {
    if is_super_maintainer(ctx)? {
        Ok(())
    } else {
        Err(Error::new("forbidden"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(user: &str, space: &str) -> AccessContext {
        AccessContext {
            user_id: user.into(),
            space_id: space.into(),
            request_id: id(),
            table_access: None,
        }
    }
    #[test]
    fn member_directory_limits_assignment_to_current_space_identities() {
        let alice = context("alice", "demo");
        let identities = DevelopmentIdentity {
            tokens: HashMap::from([
                ("alice-session".into(), alice.clone()),
                ("second-alice-session".into(), alice.clone()),
                ("bob-session".into(), context("bob", "demo")),
                ("foreign-session".into(), context("carol", "other")),
            ]),
        };
        let members = identities.members(&alice);
        assert_eq!(members.user_ids(&alice).unwrap(), ["alice", "bob"]);
        assert!(members.require_member(&alice, Some("bob")).is_ok());
        assert!(members.require_member(&alice, None).is_ok());
        for target in ["carol", "unknown"] {
            assert_eq!(
                members
                    .require_member(&alice, Some(target))
                    .unwrap_err()
                    .code,
                "invalid_input"
            );
        }
        assert_eq!(
            members
                .require_member(&context("alice", "other"), Some("alice"))
                .unwrap_err()
                .code,
            "not_available"
        );
    }
}
