mod common;

use common::build_id_token;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const ALPHA_ACCOUNT: &str = "acct-alpha";
const ALPHA_EMAIL: &str = "alpha@example.com";
const ALPHA_PLAN: &str = "team";
const ALPHA_TOKEN: &str = "token-alpha";
const ALPHA_ID: &str = "alpha@example.com-team";
const BETA_ACCOUNT: &str = "acct-beta";
const BETA_EMAIL: &str = "beta@example.com";
const BETA_PLAN: &str = "team";
const BETA_TOKEN: &str = "token-beta";
const BETA_ID: &str = "beta@example.com-team";
const FREE_ACCOUNT: &str = "acct-free";
const FREE_EMAIL: &str = "free@example.com";
const FREE_PLAN: &str = "free";
const FREE_TOKEN: &str = "token-free";

struct TestEnv {
    home: PathBuf,
}

impl TestEnv {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let home = env::temp_dir().join(format!(
            "codex-profiles-test-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(home.join(".codex")).expect("create codex dir");
        Self { home }
    }

    fn codex_dir(&self) -> PathBuf {
        self.home.join(".codex")
    }

    fn profiles_dir(&self) -> PathBuf {
        self.codex_dir().join("profiles")
    }

    fn write_config(&self, base_url: &str) {
        let path = self.codex_dir().join("config.toml");
        let contents = format!("chatgpt_base_url = \"{}\"\n", base_url);
        fs::write(path, contents).expect("write config");
    }

    fn write_auth_base(
        &self,
        account_id: &str,
        email: &str,
        plan: &str,
        access_token: &str,
        refresh_token: Option<&str>,
    ) {
        let id_token = build_id_token(email, plan);
        let mut tokens = serde_json::Map::new();
        tokens.insert(
            "account_id".to_string(),
            serde_json::Value::String(account_id.to_string()),
        );
        tokens.insert("id_token".to_string(), serde_json::Value::String(id_token));
        tokens.insert(
            "access_token".to_string(),
            serde_json::Value::String(access_token.to_string()),
        );
        if let Some(refresh_token) = refresh_token {
            tokens.insert(
                "refresh_token".to_string(),
                serde_json::Value::String(refresh_token.to_string()),
            );
        }
        let value = serde_json::Value::Object({
            let mut root = serde_json::Map::new();
            root.insert("tokens".to_string(), serde_json::Value::Object(tokens));
            root
        });
        let path = self.codex_dir().join("auth.json");
        fs::write(path, serde_json::to_string(&value).expect("serialize auth"))
            .expect("write auth.json");
    }

    fn write_auth(&self, account_id: &str, email: &str, plan: &str, access_token: &str) {
        self.write_auth_base(account_id, email, plan, access_token, None);
    }

    fn write_auth_with_refresh(
        &self,
        account_id: &str,
        email: &str,
        plan: &str,
        access_token: &str,
        refresh_token: &str,
    ) {
        self.write_auth_base(account_id, email, plan, access_token, Some(refresh_token));
    }

    fn write_profiles_index(
        &self,
        entries: &[(&str, u64)],
        labels: &[(&str, &str)],
        active_id: Option<&str>,
    ) {
        fs::create_dir_all(self.profiles_dir()).expect("create profiles dir");
        let mut profiles = serde_json::Map::new();
        let label_map: std::collections::HashMap<_, _> = labels.iter().copied().collect();
        for (id, _last_used) in entries {
            let mut entry = serde_json::Map::new();
            entry.insert("added_at".to_string(), serde_json::json!(1));
            if let Some(label) = label_map.get(id) {
                entry.insert("label".to_string(), serde_json::json!(label));
            }
            profiles.insert(id.to_string(), serde_json::Value::Object(entry));
        }
        let index = serde_json::json!({
            "version": 1,
            "active_profile_id": active_id,
            "profiles": serde_json::Value::Object(profiles)
        });
        let path = self.profiles_dir().join("profiles.json");
        fs::write(
            path,
            serde_json::to_string(&index).expect("serialize profiles.json"),
        )
        .expect("write profiles.json");
    }

    fn read_auth(&self) -> String {
        let path = self.codex_dir().join("auth.json");
        fs::read_to_string(path).expect("read auth.json")
    }

    fn run(&self, args: &[&str]) -> String {
        let output = self.run_output(args);
        self.assert_success(args, output)
    }

    fn run_expect_error(&self, args: &[&str]) -> String {
        let output = self.run_output(args);
        if output.status.success() {
            panic!(
                "command unexpectedly succeeded: {:?}\nstdout:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout)
            );
        }
        ascii_only(String::from_utf8_lossy(&output.stderr).as_ref())
    }

    fn run_output(&self, args: &[&str]) -> Output {
        self.run_output_with_env(args, &[])
    }

    fn run_output_with_env(&self, args: &[&str], extra_env: &[(&str, &str)]) -> Output {
        let bin = resolve_bin_path();
        let mut cmd = Command::new(bin);
        cmd.args(args)
            .env("HOME", &self.home)
            .env("CODEX_PROFILES_HOME", &self.home)
            .env("CODEX_PROFILES_COMMAND", "codex-profiles")
            .env("CODEX_PROFILES_SKIP_UPDATE", "1")
            .env("NO_COLOR", "1")
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .stdin(Stdio::null());
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
        if cfg!(windows) {
            cmd.env("USERPROFILE", &self.home);
            if let Some(home_str) = self.home.to_str()
                && let Some(idx) = home_str.find(':')
            {
                let (drive, rest) = home_str.split_at(idx + 1);
                cmd.env("HOMEDRIVE", drive);
                cmd.env("HOMEPATH", rest);
            }
        }
        cmd.output().expect("run command")
    }

    fn run_with_env(&self, args: &[&str], extra_env: &[(&str, &str)]) -> String {
        let output = self.run_output_with_env(args, extra_env);
        self.assert_success(args, output)
    }

    fn assert_success(&self, args: &[&str], output: Output) -> String {
        if !output.status.success() {
            panic!(
                "command failed: {:?}\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        ascii_only(String::from_utf8_lossy(&output.stdout).as_ref())
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn seed_alpha(env: &TestEnv) {
    env.write_auth(ALPHA_ACCOUNT, ALPHA_EMAIL, ALPHA_PLAN, ALPHA_TOKEN);
}

fn seed_alpha_with_token(env: &TestEnv, token: &str) {
    env.write_auth(ALPHA_ACCOUNT, ALPHA_EMAIL, ALPHA_PLAN, token);
}

fn seed_beta(env: &TestEnv) {
    env.write_auth(BETA_ACCOUNT, BETA_EMAIL, BETA_PLAN, BETA_TOKEN);
}

fn seed_free(env: &TestEnv) {
    env.write_auth(FREE_ACCOUNT, FREE_EMAIL, FREE_PLAN, FREE_TOKEN);
}

fn seed_current(env: &TestEnv) {
    env.write_auth(
        "acct-current",
        "current@example.com",
        "team",
        "token-current",
    );
}

fn ascii_only(raw: &str) -> String {
    let output = raw.replace('\r', "");
    let filtered: String = output.chars().filter(|ch| ch.is_ascii()).collect();
    filtered
        .lines()
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
}

fn resolve_bin_path() -> PathBuf {
    if let Ok(path) = env::var("CARGO_BIN_EXE_codex-profiles") {
        return PathBuf::from(path);
    }
    let exe = env::current_exe().expect("current exe");
    let target_dir = exe
        .parent()
        .and_then(|path| path.parent())
        .expect("target dir");
    let bin_name = if cfg!(windows) {
        "codex-profiles.exe"
    } else {
        "codex-profiles"
    };
    target_dir.join(bin_name)
}

fn seed_profiles(env: &TestEnv) {
    seed_alpha(env);
    env.run(&["save", "--label", "alpha"]);
    seed_beta(env);
    env.run(&["save", "--label", "beta"]);
}

fn start_usage_server(
    body: &'static str,
    max_requests: usize,
) -> std::io::Result<(SocketAddr, thread::JoinHandle<()>)> {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    start_response_server(vec![response], max_requests)
}

fn start_response_server(
    responses: Vec<String>,
    max_requests: usize,
) -> std::io::Result<(SocketAddr, thread::JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;
    let responses: Vec<Vec<u8>> = responses.into_iter().map(String::into_bytes).collect();
    let handle = thread::spawn(move || {
        let mut handled = 0usize;
        let mut last_activity = Instant::now();
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    if responses.is_empty() {
                        break;
                    }
                    let idx = handled.min(responses.len() - 1);
                    let _ = stream.write_all(&responses[idx]);
                    handled += 1;
                    last_activity = Instant::now();
                    if handled >= max_requests {
                        break;
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    if last_activity.elapsed() > Duration::from_secs(2) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                Err(_) => break,
            }
        }
    });
    Ok((addr, handle))
}

fn assert_status_output(env: &TestEnv, args: &[&str], expected_profiles: &[&str]) {
    let body = r#"{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_at":2000000000},"secondary_window":{"used_percent":50,"limit_window_seconds":604800,"reset_at":2000600000}}}"#;
    let server = start_usage_server(body, 6);
    if let Ok((addr, handle)) = server {
        env.write_config(&format!("http://{addr}/backend-api"));
        let output = env.run(args);
        assert_contains_all(&output, expected_profiles);
        if !output.contains("resets ") {
            assert!(output.contains("Error:"));
        }
        let _ = handle.join();
    } else {
        env.write_config("http://127.0.0.1:1/backend-api");
        let output = env.run(args);
        assert_contains_all(&output, expected_profiles);
        assert!(output.contains("Error:"));
    }
}

fn assert_contains_all(output: &str, expected: &[&str]) {
    for name in expected {
        assert!(output.contains(name));
    }
}

fn assert_order(output: &str, first: &str, second: &str) {
    let first_idx = output
        .find(first)
        .unwrap_or_else(|| panic!("missing expected text: {first}"));
    let second_idx = output
        .find(second)
        .unwrap_or_else(|| panic!("missing expected text: {second}"));
    assert!(
        first_idx < second_idx,
        "expected '{first}' before '{second}' in output"
    );
}

fn write_profile_tokens(env: &TestEnv, id: &str, tokens: serde_json::Value) {
    fs::create_dir_all(env.profiles_dir()).expect("create profiles dir");
    let value = serde_json::json!({ "tokens": tokens });
    let path = env.profiles_dir().join(format!("{id}.json"));
    fs::write(
        path,
        serde_json::to_string(&value).expect("serialize profile"),
    )
    .expect("write profile");
}

fn write_auth_tokens(env: &TestEnv, tokens: serde_json::Value) {
    let value = serde_json::json!({ "tokens": tokens });
    let path = env.codex_dir().join("auth.json");
    fs::write(path, serde_json::to_string(&value).expect("serialize auth")).expect("write auth");
}

fn seed_api_profile(env: &TestEnv, id: &str, account_id: &str) {
    write_profile_tokens(
        env,
        id,
        serde_json::json!({
            "account_id": account_id,
        }),
    );
}

fn seed_errored_profile(env: &TestEnv, id: &str) {
    write_profile_tokens(
        env,
        id,
        serde_json::json!({
            "account_id": "acct-errored",
            "refresh_token": "refresh-only"
        }),
    );
}

#[test]
fn ui_save_command() {
    let env = TestEnv::new();
    seed_alpha(&env);
    let output = env.run(&["save", "--label", "alpha"]);
    assert!(output.contains("Saved profile"));
    assert!(output.contains("alpha@example.com"));
    let profile_path = env.profiles_dir().join(format!("{ALPHA_ID}.json"));
    assert!(profile_path.is_file());
}

#[test]
fn ui_save_missing_auth() {
    let env = TestEnv::new();
    let err = env.run_expect_error(&["save"]);
    assert!(err.contains("Auth file not found"));
}

#[test]
fn ui_save_empty_label() {
    let env = TestEnv::new();
    seed_alpha(&env);
    let err = env.run_expect_error(&["save", "--label", "   "]);
    assert!(err.contains("Label cannot be empty"));
}

#[test]
fn ui_save_trims_label() {
    let env = TestEnv::new();
    seed_alpha(&env);
    env.run(&["save", "--label", "  work  "]);
    let index_path = env.profiles_dir().join("profiles.json");
    let index = fs::read_to_string(index_path).expect("read profiles.json");
    let json: serde_json::Value = serde_json::from_str(&index).expect("parse profiles.json");
    let label = json
        .get("profiles")
        .and_then(|profiles| profiles.get(ALPHA_ID))
        .and_then(|entry| entry.get("label"))
        .and_then(|value| value.as_str());
    assert_eq!(label, Some("work"));
}

#[test]
fn ui_save_renames_primary_candidate_to_canonical_id() {
    let env = TestEnv::new();
    seed_alpha(&env);
    fs::create_dir_all(env.profiles_dir()).expect("create profiles dir");
    let profile_one = env.profiles_dir().join(format!("{ALPHA_ID}-old.json"));
    fs::copy(env.codex_dir().join("auth.json"), &profile_one).expect("seed profile one");
    seed_alpha_with_token(&env, "token-alpha-rotated");
    let profile_two = env.profiles_dir().join(format!("{ALPHA_ID}-alt.json"));
    fs::copy(env.codex_dir().join("auth.json"), &profile_two).expect("seed profile two");
    env.write_profiles_index(&[], &[], None);
    seed_alpha_with_token(&env, "token-alpha-new");
    env.run(&["save"]);
    assert!(profile_one.is_file());
    assert!(!profile_two.is_file());
    let canonical = env.profiles_dir().join(format!("{ALPHA_ID}.json"));
    assert!(canonical.is_file());
}

#[test]
fn ui_save_duplicate_label() {
    let env = TestEnv::new();
    seed_alpha(&env);
    env.run(&["save", "--label", "alpha"]);
    seed_beta(&env);
    let err = env.run_expect_error(&["save", "--label", "alpha"]);
    assert!(err.contains("Label 'alpha' already exists"));
}

#[test]
fn ui_load_command() {
    let env = TestEnv::new();
    seed_profiles(&env);
    seed_alpha(&env);
    let output = env.run(&["load", "--label", "beta"]);
    assert!(output.contains("Loaded profile"));
    assert!(output.contains("beta@example.com"));
    assert!(env.read_auth().contains(BETA_ACCOUNT));
}

#[test]
fn ui_load_label_not_found() {
    let env = TestEnv::new();
    seed_profiles(&env);
    let err = env.run_expect_error(&["load", "--label", "missing"]);
    assert!(err.contains("Label 'missing' was not found"));
}

#[test]
fn ui_load_rejects_invalid_profile_json() {
    let env = TestEnv::new();
    fs::create_dir_all(env.profiles_dir()).expect("create profiles dir");
    let profile_path = env.profiles_dir().join("broken.json");
    fs::write(&profile_path, "{").expect("write profile");
    env.write_profiles_index(&[("broken", 123)], &[("broken", "broken")], None);
    let err = env.run_expect_error(&["load", "--label", "broken"]);
    assert!(err.contains("No saved profiles.") || err.contains("label 'broken' was not found"));
    assert!(!profile_path.is_file());
}

#[test]
fn ui_load_requires_tty() {
    let env = TestEnv::new();
    seed_profiles(&env);
    seed_alpha(&env);
    let err = env.run_expect_error(&["load"]);
    assert!(err.contains("load selection requires a TTY"));
}

#[test]
fn ui_load_unsaved_profile_requires_prompt() {
    let env = TestEnv::new();
    seed_profiles(&env);
    env.write_auth(
        "acct-current",
        "current@example.com",
        "team",
        "token-current",
    );
    let err = env.run_expect_error(&["load", "--label", "alpha"]);
    assert!(err.contains("Current profile is not saved"));
}

#[test]
fn ui_delete_command() {
    let env = TestEnv::new();
    seed_profiles(&env);
    let output = env.run(&["delete", "--label", "beta", "--yes"]);
    assert!(output.contains("Deleted profile"));
    assert!(output.contains("beta@example.com"));
    let profile_path = env.profiles_dir().join(format!("{BETA_ID}.json"));
    assert!(!profile_path.is_file());
}

#[test]
fn ui_delete_requires_tty() {
    let env = TestEnv::new();
    seed_profiles(&env);
    let err = env.run_expect_error(&["delete"]);
    assert!(err.contains("delete selection requires a TTY"));
}

#[test]
fn ui_delete_requires_confirmation() {
    let env = TestEnv::new();
    seed_profiles(&env);
    let err = env.run_expect_error(&["delete", "--label", "beta"]);
    assert!(err.contains("Deletion requires confirmation"));
}

#[test]
fn ui_delete_no_profiles() {
    let env = TestEnv::new();
    seed_alpha(&env);
    let output = env.run(&["delete", "--yes"]);
    assert!(output.contains("No saved profiles."));
}

#[test]
fn ui_delete_reports_snapshot_errors() {
    let env = TestEnv::new();
    fs::create_dir_all(env.profiles_dir()).expect("create profiles dir");
    fs::write(env.profiles_dir().join("profiles.json"), "{").expect("write invalid index");
    let err = env.run_expect_error(&["delete", "--yes"]);
    assert!(err.contains("Profiles index file"));
    assert!(err.contains("invalid JSON"));
}

#[test]
fn ui_list_command() {
    let env = TestEnv::new();
    seed_profiles(&env);
    env.write_profiles_index(
        &[(ALPHA_ID, 200), (BETA_ID, 100)],
        &[(ALPHA_ID, "alpha"), (BETA_ID, "beta")],
        None,
    );
    seed_current(&env);
    let output = env.run(&["list"]);
    assert!(output.contains("current@example.com"));
    assert!(output.contains("Warning: This profile is not saved yet."));
    assert!(output.contains("Run `codex-profiles save` to save this profile."));
    assert!(output.contains("alpha@example.com"));
    assert!(output.contains("beta@example.com"));
    assert_order(&output, "current@example.com", "alpha@example.com");
    assert_order(&output, "alpha@example.com", "beta@example.com");
}

#[test]
fn ui_list_free_plan() {
    let env = TestEnv::new();
    seed_free(&env);
    env.run(&["save", "--label", "free"]);
    let output = env.run(&["list"]);
    assert!(output.contains(FREE_EMAIL));
    assert!(!output.contains("You need a ChatGPT subscription to use Codex CLI"));
    assert!(!output.contains("Data not available"));
}

#[test]
fn ui_list_unsaved_free_profile_shows_warning() {
    let env = TestEnv::new();
    seed_alpha(&env);
    env.run(&["save", "--label", "alpha"]);
    seed_free(&env);

    let output = env.run(&["list"]);
    assert!(output.contains(FREE_EMAIL));
    assert!(output.contains("Warning: This profile is not saved yet."));
    assert!(output.contains("Run `codex-profiles save` to save this profile."));
}

#[test]
fn ui_list_does_not_sync_current_profile() {
    let env = TestEnv::new();
    seed_alpha(&env);
    env.run(&["save", "--label", "alpha"]);
    seed_alpha_with_token(&env, "token-alpha-rotated");
    env.run(&["list"]);
    let profile_path = env.profiles_dir().join(format!("{ALPHA_ID}.json"));
    let contents = fs::read_to_string(profile_path).expect("read profile");
    assert!(!contents.contains("token-alpha-rotated"));
    assert!(contents.contains(ALPHA_TOKEN));
}

#[test]
fn ui_profiles_index_does_not_store_last_used() {
    let env = TestEnv::new();
    seed_profiles(&env);
    let index_path = env.profiles_dir().join("profiles.json");
    let index = fs::read_to_string(index_path).expect("read profiles.json");
    let json: serde_json::Value = serde_json::from_str(&index).expect("parse profiles.json");
    let profiles = json.get("profiles").expect("profiles map");
    let alpha_last_used = profiles
        .get(ALPHA_ID)
        .and_then(|entry| entry.get("last_used"))
        .and_then(|value| value.as_u64());
    let beta_last_used = profiles
        .get(BETA_ID)
        .and_then(|entry| entry.get("last_used"))
        .and_then(|value| value.as_u64());
    assert!(alpha_last_used.is_none());
    assert!(beta_last_used.is_none());
}

#[test]
fn ui_save_adds_missing_profiles_to_index() {
    let env = TestEnv::new();
    seed_alpha(&env);
    let profile_path = env.profiles_dir().join(format!("{ALPHA_ID}.json"));
    fs::create_dir_all(env.profiles_dir()).expect("create profiles dir");
    fs::copy(env.codex_dir().join("auth.json"), &profile_path).expect("seed profile file");
    env.write_profiles_index(&[], &[], None);
    seed_beta(&env);
    let output = env.run(&["save", "--label", "beta"]);
    assert!(output.contains("Saved profile"));
    let contents =
        fs::read_to_string(env.profiles_dir().join("profiles.json")).expect("read profiles.json");
    let json: serde_json::Value = serde_json::from_str(&contents).expect("parse profiles.json");
    let profiles = json.get("profiles").expect("profiles map");
    assert!(profiles.get(ALPHA_ID).is_some());
    assert!(profiles.get(BETA_ID).is_some());
}

#[test]
fn ui_status_command() {
    let env = TestEnv::new();
    seed_profiles(&env);
    seed_alpha(&env);
    assert_status_output(&env, &["status"], &["alpha@example.com"]);
    let output = env.run(&["status"]);
    assert!(output.contains("alpha@example.com"));
    assert!(!output.contains("beta@example.com"));
}

#[test]
fn ui_status_rejects_label_flag() {
    let env = TestEnv::new();
    seed_profiles(&env);
    seed_alpha(&env);
    let err = env.run_expect_error(&["status", "--label", "beta"]);
    assert!(err.contains("unexpected argument '--label'"));
}

#[test]
fn ui_status_all_command() {
    let env = TestEnv::new();
    seed_profiles(&env);
    env.write_profiles_index(
        &[(ALPHA_ID, 200), (BETA_ID, 100)],
        &[(ALPHA_ID, "alpha"), (BETA_ID, "beta")],
        None,
    );
    seed_alpha(&env);
    assert_status_output(
        &env,
        &["status", "--all"],
        &["alpha@example.com", "beta@example.com"],
    );
    let output = env.run(&["status", "--all", "--show-errors"]);
    assert_order(&output, "alpha@example.com", "beta@example.com");
}

#[test]
fn ui_status_all_unsaved_free_profile_shows_warning() {
    let env = TestEnv::new();
    seed_alpha(&env);
    env.run(&["save", "--label", "alpha"]);
    seed_free(&env);

    let usage_body = r#"{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_at":2000000000}}}"#;
    let (usage_addr, usage_handle) = start_usage_server(usage_body, 6).expect("usage server");
    env.write_config(&format!("http://{usage_addr}/backend-api"));

    let output = env.run(&["status", "--all"]);
    assert!(output.contains(FREE_EMAIL));
    assert!(output.contains("Warning: This profile is not saved yet."));
    assert!(output.contains("Run `codex-profiles save` to save this profile."));
    let _ = usage_handle.join();
}

#[test]
fn ui_status_all_no_usage() {
    let env = TestEnv::new();
    seed_profiles(&env);
    env.write_profiles_index(
        &[(ALPHA_ID, 200), (BETA_ID, 100)],
        &[(ALPHA_ID, "alpha"), (BETA_ID, "beta")],
        None,
    );
    seed_alpha(&env);
    env.write_config("http://127.0.0.1:1/backend-api");
    let output = env.run(&["status", "--all", "--show-errors"]);
    assert!(output.contains("alpha@example.com"));
    assert!(output.contains("beta@example.com"));
    assert!(output.contains("Error:"));
}

#[test]
fn ui_status_all_hides_api_profiles_by_default() {
    let env = TestEnv::new();
    seed_profiles(&env);
    seed_alpha(&env);
    seed_api_profile(&env, "api-key-hidden", "api-key-sk-proj-hidden1234567890");
    env.write_profiles_index(
        &[(ALPHA_ID, 300), (BETA_ID, 200), ("api-key-hidden", 100)],
        &[(ALPHA_ID, "alpha"), (BETA_ID, "beta")],
        None,
    );
    let usage_body = r#"{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_at":2000000000}}}"#;
    let (usage_addr, usage_handle) = start_usage_server(usage_body, 6).expect("usage server");
    env.write_config(&format!("http://{usage_addr}/backend-api"));

    let output = env.run(&["status", "--all"]);
    assert!(output.contains("alpha@example.com"));
    assert!(output.contains("beta@example.com"));
    assert!(output.contains("+ 1 API profiles hidden"));
    assert!(!output.contains("Usage unavailable for API key"));
    let _ = usage_handle.join();
}

#[test]
fn ui_status_all_hides_errored_profiles_by_default() {
    let env = TestEnv::new();
    seed_profiles(&env);
    seed_alpha(&env);
    seed_errored_profile(&env, "gamma@example.com-team");
    env.write_profiles_index(
        &[
            (ALPHA_ID, 300),
            (BETA_ID, 200),
            ("gamma@example.com-team", 100),
        ],
        &[(ALPHA_ID, "alpha"), (BETA_ID, "beta")],
        None,
    );
    let usage_body = r#"{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_at":2000000000}}}"#;
    let (usage_addr, usage_handle) = start_usage_server(usage_body, 6).expect("usage server");
    env.write_config(&format!("http://{usage_addr}/backend-api"));

    let output = env.run(&["status", "--all"]);
    assert!(output.contains("alpha@example.com"));
    assert!(output.contains("beta@example.com"));
    assert!(output.contains("+ 1 errored profiles hidden (use `--show-errors`)"));
    assert!(!output.contains("Profile is missing"));
    let _ = usage_handle.join();
}

#[test]
fn ui_status_all_show_errors_includes_errored_profiles() {
    let env = TestEnv::new();
    seed_profiles(&env);
    seed_alpha(&env);
    seed_errored_profile(&env, "gamma@example.com-team");
    env.write_profiles_index(
        &[
            (ALPHA_ID, 300),
            (BETA_ID, 200),
            ("gamma@example.com-team", 100),
        ],
        &[(ALPHA_ID, "alpha"), (BETA_ID, "beta")],
        None,
    );
    let usage_body = r#"{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_at":2000000000}}}"#;
    let (usage_addr, usage_handle) = start_usage_server(usage_body, 6).expect("usage server");
    env.write_config(&format!("http://{usage_addr}/backend-api"));

    let output = env.run(&["status", "--all", "--show-errors"]);
    assert!(output.contains("alpha@example.com"));
    assert!(output.contains("beta@example.com"));
    assert!(output.contains("Error: Profile is missing email or plan information."));
    assert!(!output.contains("errored profiles hidden"));
    let _ = usage_handle.join();
}

#[test]
fn ui_status_all_hides_current_api_profile() {
    let env = TestEnv::new();
    seed_profiles(&env);
    seed_api_profile(&env, "api-key-current", "api-key-sk-proj-current1234567890");
    seed_api_profile(&env, "api-key-hidden", "api-key-sk-proj-hidden1234567890");
    env.write_profiles_index(
        &[
            (ALPHA_ID, 300),
            (BETA_ID, 200),
            ("api-key-current", 150),
            ("api-key-hidden", 100),
        ],
        &[(ALPHA_ID, "alpha"), (BETA_ID, "beta")],
        None,
    );
    write_auth_tokens(
        &env,
        serde_json::json!({
            "account_id": "api-key-sk-proj-current1234567890",
        }),
    );
    let usage_body = r#"{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_at":2000000000}}}"#;
    let (usage_addr, usage_handle) = start_usage_server(usage_body, 6).expect("usage server");
    env.write_config(&format!("http://{usage_addr}/backend-api"));

    let output = env.run(&["status", "--all"]);
    assert!(output.contains("alpha@example.com"));
    assert!(output.contains("beta@example.com"));
    assert!(!output.contains("Usage unavailable for API key"));
    assert!(output.contains("+ 2 API profiles hidden"));
    let _ = usage_handle.join();
}

#[test]
fn ui_list_removes_invalid_profiles() {
    let env = TestEnv::new();
    fs::create_dir_all(env.profiles_dir()).expect("create profiles dir");
    let bad_profile = env.profiles_dir().join("bad.json");
    fs::write(&bad_profile, "{").expect("write bad profile");
    env.write_profiles_index(&[("bad", 123)], &[("bad", "bad")], None);

    env.run(&["list"]);

    assert!(!bad_profile.is_file());
    let index =
        fs::read_to_string(env.profiles_dir().join("profiles.json")).expect("read profiles.json");
    let json: serde_json::Value = serde_json::from_str(&index).expect("parse profiles.json");
    let profiles = json.get("profiles").expect("profiles map");
    assert!(profiles.get("bad").is_none());
}

#[test]
fn ui_status_refresh_updates_profile() {
    let env = TestEnv::new();
    let usage_body = r#"{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_at":2000000000}}}"#;
    let usage_ok = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        usage_body.len(),
        usage_body
    );
    let usage_unauthorized = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n".to_string();
    let refresh_id_token = build_id_token(ALPHA_EMAIL, ALPHA_PLAN);
    let refresh_body = format!(
        "{{\"id_token\":\"{refresh_id_token}\",\"access_token\":\"new-access\",\"refresh_token\":\"new-refresh\"}}"
    );
    let (usage_addr, usage_handle) =
        start_response_server(vec![usage_unauthorized, usage_ok], 4).expect("usage server");
    let (refresh_addr, refresh_handle) =
        start_usage_server(Box::leak(refresh_body.into_boxed_str()), 2).expect("refresh server");

    env.write_config(&format!("http://{usage_addr}/backend-api"));
    env.write_auth_with_refresh(
        ALPHA_ACCOUNT,
        ALPHA_EMAIL,
        ALPHA_PLAN,
        "old-access",
        "refresh-old",
    );
    env.run(&["save", "--label", "alpha"]);

    let refresh_url = format!("http://{refresh_addr}/token");
    env.run_with_env(
        &["status"],
        &[("CODEX_REFRESH_TOKEN_URL_OVERRIDE", refresh_url.as_str())],
    );

    let auth_contents = env.read_auth();
    assert!(auth_contents.contains("new-access"));
    let profile_path = env.profiles_dir().join(format!("{ALPHA_ID}.json"));
    let profile_contents = fs::read_to_string(profile_path).expect("read profile");
    assert!(profile_contents.contains("new-access"));

    let _ = usage_handle.join();
    let _ = refresh_handle.join();
}

#[test]
fn ui_status_all_uses_usage_path_when_id_token_missing() {
    let env = TestEnv::new();
    let profile_id = "mail1@example.com-team";
    write_profile_tokens(
        &env,
        profile_id,
        serde_json::json!({
            "account_id": "acct-mail-1",
            "access_token": "token-mail-1",
            "refresh_token": "refresh-mail-1"
        }),
    );
    env.write_profiles_index(
        &[(profile_id, 10)],
        &[(profile_id, "mail1")],
        Some(profile_id),
    );
    seed_current(&env);

    let usage_402_body = r#"{"error":"payment_required"}"#;
    let usage_402_resp = format!(
        "HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        usage_402_body.len(),
        usage_402_body
    );
    let (usage_addr, usage_handle) = start_response_server(vec![usage_402_resp], 4).expect("usage");
    env.write_config(&format!("http://{usage_addr}/backend-api"));

    let output = env.run(&["status", "--all", "--show-errors"]);
    assert!(output.contains("mail1"));
    assert!(output.contains("Usage unavailable (402)"));
    assert!(!output.contains("Auth is incomplete. Run `codex login`."));

    let _ = usage_handle.join();
}

#[test]
fn ui_status_api_key_error_message_is_standardized() {
    let env = TestEnv::new();
    write_auth_tokens(
        &env,
        serde_json::json!({
            "account_id": "api-key-sk-proj-abcdef1234567890",
            "refresh_token": ""
        }),
    );

    let output = env.run(&["status"]);
    assert!(output.contains("Error: Usage unavailable for API key"));
    assert!(
        output.contains("Rate-limit usage data is only available for ChatGPT account profiles.")
    );
}
