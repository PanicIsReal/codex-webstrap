use codex_profiles::parse_config_value;

#[test]
fn parses_config_value_with_inline_comment() {
    let line = r#"chatgpt_base_url = "https://chatgpt.com/backend-api" # comment"#;
    let value = parse_config_value(line, "chatgpt_base_url");
    assert_eq!(value.as_deref(), Some("https://chatgpt.com/backend-api"));
}

#[test]
fn preserves_hash_inside_quotes() {
    let line = r#"chatgpt_base_url = "https://example.com/#/foo" # tail"#;
    let value = parse_config_value(line, "chatgpt_base_url");
    assert_eq!(value.as_deref(), Some("https://example.com/#/foo"));
}

#[test]
fn ignores_other_keys_and_empty_values() {
    assert!(parse_config_value("other = \"value\"", "chatgpt_base_url").is_none());
    assert!(parse_config_value("chatgpt_base_url = '' # comment", "chatgpt_base_url").is_none());
}
