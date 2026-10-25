use crate::{
    contracts::generated::SourceLocator,
    types::{Error, Result},
};

impl SourceLocator {
    pub fn slice<'a>(&self, text: &'a str) -> Result<&'a str> {
        let offset = usize::try_from(self.offset).map_err(|_| Error::new("invalid_input"))?;
        let length = usize::try_from(self.length).map_err(|_| Error::new("invalid_input"))?;
        // 合同计code point，不把Rust字节或前端UTF-16下标当作位置。
        let mut boundaries = text
            .char_indices()
            .map(|(index, _)| index)
            .chain([text.len()]);
        let start = boundaries.nth(offset).ok_or(Error::new("invalid_input"))?;
        let end = if length == 0 {
            start
        } else {
            boundaries
                .nth(length - 1)
                .ok_or(Error::new("invalid_input"))?
        };
        Ok(&text[start..end])
    }
}

#[cfg(test)]
mod tests {
    use crate::contracts::{self, generated::SourceLocator};
    use serde_json::json;

    #[test]
    fn unicode_code_points_preserve_emoji_combining_marks_and_newlines() {
        let locator: SourceLocator = contracts::decode(
            "SourceLocator",
            json!({"offset":1,"length":4,"heading_path":["字段说明"]}),
        )
        .unwrap();
        assert_eq!(locator.slice("A语🧪e\u{301}\nZ").unwrap(), "语🧪e\u{301}");
    }
}
