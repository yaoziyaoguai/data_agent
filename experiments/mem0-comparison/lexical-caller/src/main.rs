use data_agent::modules::retrieval::asset_directory;
use serde_json::Value;
use std::io::{self, BufRead, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut output = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let items = request["items"].as_array().ok_or("items_required")?;
        let query = request["query"].as_str().ok_or("query_required")?;
        let result = asset_directory(items.clone(), query, None, 20);
        serde_json::to_writer(&mut output, &result)?;
        writeln!(&mut output)?;
        output.flush()?;
    }
    Ok(())
}
