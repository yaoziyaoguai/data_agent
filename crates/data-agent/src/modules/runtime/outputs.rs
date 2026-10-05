use super::store::{self, LockedRun};
use crate::{
    persistence::AppTx,
    types::{Error, Result},
};
pub async fn append_output_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    seq: u64,
    body: &str,
) -> Result<()> {
    let chunks = store::chunks(tx, run).await?;
    if let Some((_, previous)) = chunks.iter().find(|(n, _)| *n == seq) {
        if previous != body {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(());
    }
    if seq != chunks.len() as u64 + 1 {
        return Err(Error::new("chunk_gap"));
    }
    store::insert_chunk(tx, run, seq, body).await
}
pub async fn read_output_text_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    start_seq: u64,
) -> Result<String> {
    let chunks = store::chunks(tx, run).await?;
    assemble_output(chunks, start_seq)
}

fn assemble_output(chunks: Vec<(u64, String)>, start_seq: u64) -> Result<String> {
    if start_seq == 0 || start_seq > chunks.len() as u64 {
        return Err(Error::new("chunk_gap"));
    }
    for (index, (seq, _)) in chunks.iter().enumerate() {
        if *seq != index as u64 + 1 {
            return Err(Error::new("chunk_gap"));
        }
    }
    Ok(chunks
        .into_iter()
        .filter(|(seq, _)| *seq >= start_seq)
        .map(|(_, text)| text)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_answer_can_follow_process_fragments() {
        let chunks = vec![
            (1, "调查过程".into()),
            (2, "正式".into()),
            (3, "回答".into()),
        ];
        assert_eq!(
            assemble_output(chunks.clone(), 1).unwrap(),
            "调查过程正式回答"
        );
        assert_eq!(assemble_output(chunks, 2).unwrap(), "正式回答");
    }

    #[test]
    fn selecting_the_final_answer_cannot_hide_gaps_or_invalid_bounds() {
        assert!(assemble_output(vec![(1, "过程".into()), (3, "回答".into())], 2).is_err());
        assert!(assemble_output(vec![(1, "过程".into()), (3, "回答".into())], 3).is_err());
        assert!(assemble_output(vec![(1, "回答".into())], 0).is_err());
        assert!(assemble_output(vec![(1, "回答".into())], 2).is_err());
    }
}
