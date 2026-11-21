use crate::{
    modules::{
        ingestion, jobs,
        knowledge::dependency_index::{
            has_dependents_in_tx, rows_for_object, write_target_fingerprints_in_tx,
        },
    },
    persistence::AppTx,
    types::{AccessContext, Result, epoch},
};
use serde_json::Value;

// 知识内容保存后的跨模块登记组合：模块内保存只落knowledge表族；这里补齐依赖目标的
// 相关内容指纹（平台来源正文归ingestion，经公开读取批量取回）并为被依赖对象排队
// 来源扇出作业。保存与登记同事务，任一失败整体回滚。
//
// 来源扇出：被有效依赖的对象每次落库登记轻量作业，由Worker按页发现依赖者并为其
// 来源排队重整；(kind,resource,version)唯一键幂等，内容未变的链条在消费侧按指纹
// 终止。创建首版没有依赖行，判定自然为空，不产生作业。文档对象以document-前缀
// 登记，与prepare_source资源身份一致。
pub async fn after_content_saved_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    saved: &[Value],
) -> Result<()> {
    for object in saved {
        let indexed = rows_for_object(object)?;
        let mut platform_pairs = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for row in &indexed.rows {
            if row.target_kind == "platform"
                && seen.insert((row.target_id.clone(), row.target_revision))
            {
                platform_pairs.push((row.target_id.clone(), row.target_revision));
            }
        }
        let platform_bodies = ingestion::snapshot_bodies_in_tx(tx, &platform_pairs).await?;
        write_target_fingerprints_in_tx(tx, &indexed.rows, &platform_bodies).await?;
        let kind = object["kind"].as_str().unwrap_or("");
        let id = object["id"].as_str().unwrap_or("");
        if has_dependents_in_tx(tx, ctx, kind, id).await? {
            let fanout_resource = match kind {
                "document" => format!("document-{id}"),
                _ => id.to_owned(),
            };
            jobs::enqueue_source_in_tx(
                tx,
                "source_fanout",
                &fanout_resource,
                epoch(object["version"].as_str().unwrap_or("0"))?,
            )
            .await?;
        }
    }
    if !saved.is_empty() {
        tx.notify(crate::live_changes::Change::Catalog {
            space_id: ctx.space_id.clone(),
        });
    }
    Ok(())
}
