use crate::{
    persistence::AppTx,
    types::{AccessContext, Result},
};
use serde_json::{Value, json};
use sqlx::Row;

pub async fn find_skill_dependents_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    target: &Value,
    after: Option<&str>,
    can_admin: bool,
) -> Result<(Vec<Value>, Option<String>)> {
    // 归属和可见范围先于匹配、排序和分页；维护角色不扩大私人读取范围。
    let rows = sqlx::query("SELECT body,owner_id,visibility FROM personal_assets WHERE space_id=? AND kind='skill' AND state<>'deleted' AND (owner_id=? OR visibility='space') AND (? IS NULL OR id>?) AND JSON_CONTAINS(JSON_EXTRACT(body,'$.dependencies'),JSON_OBJECT('object_id',?)) ORDER BY id LIMIT 51")
        .bind(&ctx.space_id).bind(&ctx.user_id).bind(after).bind(after)
        .bind(target["id"].as_str()).fetch_all(tx.connection()).await?;
    let next = (rows.len() > 50).then(|| {
        rows[49].get::<sqlx::types::Json<Value>, _>("body").0["id"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    });
    let mut values = Vec::new();
    for row in rows.into_iter().take(50) {
        let mut asset = row.get::<sqlx::types::Json<Value>, _>("body").0;
        asset["owner_id"] = json!(row.get::<String, _>("owner_id"));
        asset["visibility"] = json!(row.get::<String, _>("visibility"));
        let references = asset["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|reference| reference["object_id"] == target["id"])
            .map(|reference| {
                let state = if target["state"] != "enabled" {
                    "unavailable"
                } else if reference["version"] != target["version"] {
                    "version_changed"
                } else {
                    "current"
                };
                json!({"dependent_path":"dependencies","relation_kind":"skill",
                    "referenced_version":reference["version"],"referenced_path":reference["path"],
                    "reference_state":state})
            })
            .collect::<Vec<_>>();
        let complete = references.len() <= 50;
        values.push(json!({"id":asset["id"],"kind":"skill","name":asset["name"],
            "version":asset["version"],"state":asset["state"],"visibility":asset["visibility"],
            "can_edit":super::super::store::can_edit(ctx,&asset,can_admin),
            "references":references.into_iter().take(50).collect::<Vec<_>>(),
            "references_complete":complete}));
    }
    Ok((values, next))
}
