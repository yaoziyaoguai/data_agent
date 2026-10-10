-- SQL 上限按字符计，容量需覆盖 24,000 字符的多字节 SQL。
ALTER TABLE query_requests MODIFY COLUMN sql_text MEDIUMTEXT NOT NULL;
