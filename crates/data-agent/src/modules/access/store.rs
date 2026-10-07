use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use serde_json::{Value, json};
use sqlx::Row;

pub async fn can_create_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<bool> {
    // 锁住一个当前有效的表维护关系，创建与该关系撤回按事务先后生效。
    read_can_create_in_tx(tx, ctx, true).await
}

pub async fn can_create_snapshot_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<bool> {
    // 展示只读取已提交资格；实际创建仍须调用带锁的当前授权检查。
    read_can_create_in_tx(tx, ctx, false).await
}

async fn read_can_create_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    lock_authorization: bool,
) -> Result<bool> {
    if super::is_super_maintainer(ctx)? {
        return Ok(true);
    }
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT object_id FROM semantic_ownership WHERE space_id=",
    );
    sql.push_bind(&ctx.space_id)
        .push(" AND source='datasight' AND maintainer_id=")
        .push_bind(&ctx.user_id)
        .push(" AND authority_id=object_id ORDER BY object_id LIMIT 1");
    if lock_authorization {
        sql.push(" FOR SHARE");
    }
    let table: Option<String> = sql
        .build_query_scalar()
        .fetch_optional(tx.connection())
        .await?;
    Ok(table.is_some())
}

pub async fn register_creator_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<()> {
    // 仅首次创建登记。重放旧创建请求不能覆盖之后的转交或撤销。
    sqlx::query("INSERT IGNORE INTO semantic_ownership(space_id,object_id,authority_id,maintainer_id,source,updated_by) VALUES(?,?,?,?,'creator',?)")
        .bind(&ctx.space_id).bind(object).bind(object).bind(&ctx.user_id).bind(&ctx.user_id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn register_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    authority: &str,
    source: &str,
) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM semantic_ownership WHERE space_id=? AND object_id=?)",
    )
    .bind(&ctx.space_id)
    .bind(object)
    .fetch_one(tx.connection())
    .await?;
    if exists {
        return Ok(());
    }
    sqlx::query("INSERT IGNORE INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) VALUES(?,?,?,?,?)")
        .bind(&ctx.space_id).bind(object).bind(authority).bind(source).bind(&ctx.user_id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn maintenance_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<Value> {
    // 授权和正式保存处于同一事务；负责人同步或撤销需等待此共享锁释放。
    read_maintenance_in_tx(tx, ctx, object, true).await
}

pub async fn maintenance_snapshot_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<Value> {
    // 页面列表按知识对象排序，不持有跨表授权锁；修改动作必须另行当前读授权。
    read_maintenance_in_tx(tx, ctx, object, false).await
}

async fn read_maintenance_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    lock_authorization: bool,
) -> Result<Value> {
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT b.authority_id,o.maintainer_id,o.source,o.version FROM semantic_ownership b JOIN semantic_ownership o ON o.space_id=b.space_id AND o.object_id=b.authority_id WHERE b.space_id=",
    );
    sql.push_bind(&ctx.space_id)
        .push(" AND b.object_id=")
        .push_bind(object);
    if lock_authorization {
        sql.push(" FOR SHARE");
    }
    let row = sql
        .build()
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    let owner: Option<String> = row.get("maintainer_id");
    let source: String = row.get("source");
    let authority: String = row.get("authority_id");
    let admin = super::is_super_maintainer(ctx)?;
    Ok(
        json!({"authority_id":authority,"maintainer_id":owner,"source":source,"version":row.get::<u64,_>("version").to_string(),"can_edit":admin || owner.as_deref()==Some(ctx.user_id.as_str()),"can_assign":admin && source!="datasight" && authority==object}),
    )
}

pub async fn authorize_semantic_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<()> {
    if maintenance_in_tx(tx, ctx, object).await?["can_edit"] != true {
        return Err(Error::new("forbidden"));
    }
    Ok(())
}

pub async fn maintainable_ids_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar("SELECT b.object_id FROM semantic_ownership b JOIN semantic_ownership o ON o.space_id=b.space_id AND o.object_id=b.authority_id WHERE b.space_id=? AND o.maintainer_id=? ORDER BY b.object_id")
        .bind(&ctx.space_id).bind(&ctx.user_id).fetch_all(tx.connection()).await?)
}

pub async fn sync_maintainer_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    owner: Option<&str>,
) -> Result<()> {
    sqlx::query("UPDATE semantic_ownership SET version=version+1,maintainer_id=?,updated_by='datasight' WHERE space_id=? AND object_id=? AND authority_id=object_id AND source='datasight' AND NOT (maintainer_id <=> ?)")
        .bind(owner).bind(&ctx.space_id).bind(object).bind(owner).execute(tx.connection()).await?;
    Ok(())
}

pub async fn assign_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
) -> Result<Value> {
    super::authorize_maintainer(ctx)?;
    let row=sqlx::query("SELECT authority_id,source,version FROM semantic_ownership WHERE space_id=? AND object_id=? FOR UPDATE")
        .bind(&ctx.space_id).bind(object).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    if row.get::<String, _>("source") == "datasight"
        || row.get::<String, _>("authority_id") != object
    {
        return Err(Error::new("forbidden"));
    }
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let fp = fingerprint(&json!([object, input]));
    let previous=sqlx::query("SELECT fingerprint,receipt FROM semantic_owner_operations WHERE space_id=? AND owner_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.space_id).bind(&ctx.user_id).bind(key).fetch_optional(tx.connection()).await?;
    if let Some(previous) = previous {
        if previous.get::<String, _>("fingerprint") != fp {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(previous.get::<sqlx::types::Json<Value>, _>("receipt").0);
    }
    if row.get::<u64, _>("version") != epoch(input["expected_version"].as_str().unwrap_or(""))? {
        return Err(Error::new("version_conflict"));
    }
    sqlx::query("UPDATE semantic_ownership SET maintainer_id=?,source='system',version=version+1,updated_by=? WHERE space_id=? AND object_id=?")
        .bind(input["maintainer_id"].as_str()).bind(&ctx.user_id).bind(&ctx.space_id).bind(object).execute(tx.connection()).await?;
    let v = maintenance_in_tx(tx, ctx, object).await?;
    sqlx::query("INSERT INTO semantic_owner_operations(space_id,owner_id,operation_id,fingerprint,receipt) VALUES(?,?,?,?,?)")
        .bind(&ctx.space_id).bind(&ctx.user_id).bind(key).bind(fp).bind(sqlx::types::Json(&v)).execute(tx.connection()).await?;
    Ok(v)
}
