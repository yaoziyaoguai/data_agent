use serde_json::{Value, json};
use sqlparser::{
    dialect::GenericDialect,
    tokenizer::{Token, Tokenizer, Whitespace},
};

// 只忽略词间排版；使用原始token片段而非格式化SQL，避免改写引用、大小写或转义。
fn sql_content(sql: &str) -> Value {
    // 平台尚未声明方言：三引号等歧义形式不使用通用词法器证明排版等价。
    if sql.contains("\"\"\"") || sql.contains("'''") {
        return json!({"raw":sql});
    }
    let Ok(tokens) = Tokenizer::new(&GenericDialect, sql)
        .with_unescape(false)
        .tokenize_with_location()
    else {
        return json!({"raw":sql});
    };
    let mut characters = sql.char_indices();
    let (mut line, mut column, mut end) = (1, 1, 0);
    let mut parts = Vec::new();
    let (mut previous_quoted, mut newline) = (false, false);
    for token in tokens {
        let start = end;
        while (line, column) != (token.span.end.line, token.span.end.column) {
            let Some((index, character)) = characters.next() else {
                return json!({"raw":sql});
            };
            end = index + character.len_utf8();
            if character == '\n' {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
        }
        let raw = &sql[start..end];
        if matches!(&token.token,Token::Word(word) if word.quote_style.is_none() && raw.contains('#'))
        {
            return json!({"raw":sql});
        }
        let quoted = matches!(
            &token.token,
            Token::SingleQuotedString(_)
                | Token::DoubleQuotedString(_)
                | Token::DollarQuotedString(_)
                | Token::NationalStringLiteral(_)
                | Token::EscapedStringLiteral(_)
                | Token::UnicodeStringLiteral(_)
                | Token::HexStringLiteral(_)
                | Token::SingleQuotedByteStringLiteral(_)
                | Token::DoubleQuotedByteStringLiteral(_)
        );
        match token.token {
            // 方括号/井号/双斜线在不同方言中可能是标识符、注释或运算符。
            Token::Char(_)
            | Token::LBracket
            | Token::RBracket
            | Token::Sharp
            | Token::DoubleSharp
            | Token::DuckIntDiv => return json!({"raw":sql}),
            Token::Whitespace(Whitespace::Space | Whitespace::Tab | Whitespace::Newline) => {
                newline |= raw.contains(['\r', '\n']);
                continue;
            }
            Token::Whitespace(Whitespace::SingleLineComment { .. }) => {
                parts.push(json!({"comment":raw.trim_end_matches(['\r','\n'])}));
                newline |= raw.contains(['\r', '\n']);
                continue;
            }
            Token::Whitespace(Whitespace::MultiLineComment(_)) => {
                parts.push(json!({"comment":raw}));
                newline |= raw.contains(['\r', '\n']);
                continue;
            }
            _ => {}
        }
        // 相邻字符串间换行在部分方言中有语义，不按普通排版丢弃。
        if quoted && previous_quoted {
            parts.push(json!({"literal_separator_newline":newline}));
        }
        parts.push(json!({"token":raw}));
        previous_quoted = quoted;
        newline = false;
    }
    json!({"tokens":parts})
}

pub const METHOD: &str = "sql_tokens_v2";

pub fn comparison(table: &Value) -> (String, bool) {
    let mut content = table.clone();
    if let Some(fields) = content.as_object_mut() {
        fields.remove("platform_version");
        fields.remove("maintainer_id");
    }
    content["ddl"] = sql_content(table["ddl"].as_str().unwrap_or(""));
    if content["node"].is_object() {
        content["node"]["sql"] = sql_content(table["node"]["sql"].as_str().unwrap_or(""));
    }
    let parsed = content["ddl"]["raw"].is_null()
        && (content["node"].is_null() || content["node"]["sql"]["raw"].is_null());
    (crate::types::fingerprint(&content), parsed)
}
pub fn fingerprint(table: &Value) -> String {
    comparison(table).0
}

#[cfg(test)]
mod tests {
    use super::comparison;
    use serde_json::json;
    fn compared(sql: &str) -> (String, bool) {
        comparison(&json!({"id":"voice","ddl":sql,"node":null}))
    }

    #[test]
    fn unsupported_quoting_and_comment_syntax_keeps_raw_content() {
        for (left, right) in [
            ("SELECT [a b] FROM t", "SELECT [a  b] FROM t"),
            (
                "SELECT \"\"\"a\" x \"b\"\"\"",
                "SELECT \"\"\"a\"  x  \"b\"\"\"",
            ),
            ("SELECT 1 // 首次 成功", "SELECT 1 // 首次  成功"),
            ("SELECT 1 # 首次 成功", "SELECT 1 # 首次  成功"),
            ("SELECT 1 #note + 2", "SELECT 1 #note\n+ 2"),
            ("SELECT 1 ##note + 2", "SELECT 1 ##note\n+ 2"),
        ] {
            assert_ne!(compared(left).0, compared(right).0, "{left}");
            assert!(
                !compared(left).1,
                "方言未明时不能将歧义词法标为已解析：{left}"
            );
        }
    }

    #[test]
    fn adjacent_literals_preserve_carriage_return_semantics() {
        assert_ne!(compared("SELECT 'a' 'b'").0, compared("SELECT 'a'\r'b'").0);
        assert_eq!(compared("SELECT 'a'\r'b'").0, compared("SELECT 'a'\n'b'").0);
    }

    #[test]
    fn quoted_identifier_aliases_ignore_intertoken_layout() {
        for quote in ['"', '`'] {
            assert_eq!(
                compared(&format!(
                    "SELECT {quote}field{quote} {quote}label{quote} FROM t"
                ))
                .0,
                compared(&format!(
                    "SELECT {quote}field{quote}\n{quote}label{quote} FROM t"
                ))
                .0
            );
        }
    }
}
