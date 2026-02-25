use chrono::{DateTime, Local};
use colored::Colorize;
use inquire::{Confirm, MultiSelect, Select};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::fs;
use std::io::{self, IsTerminal as _};
use std::path::{Path, PathBuf};

use crate::{
    AUTH_ERR_INCOMPLETE_ACCOUNT, AUTH_ERR_PROFILE_MISSING_EMAIL_PLAN, PROFILE_COPY_CONTEXT_LOAD,
    PROFILE_COPY_CONTEXT_SAVE, PROFILE_DELETE_HELP, PROFILE_ERR_COPY_CONTEXT,
    PROFILE_ERR_CURRENT_NOT_SAVED, PROFILE_ERR_DELETE_CONFIRM_REQUIRED, PROFILE_ERR_FAILED_DELETE,
    PROFILE_ERR_ID_NOT_FOUND, PROFILE_ERR_INDEX_INVALID_JSON, PROFILE_ERR_LABEL_EMPTY,
    PROFILE_ERR_LABEL_EXISTS, PROFILE_ERR_LABEL_NO_MATCH, PROFILE_ERR_LABEL_NOT_FOUND,
    PROFILE_ERR_PROMPT_CONTEXT, PROFILE_ERR_PROMPT_DELETE, PROFILE_ERR_PROMPT_LOAD,
    PROFILE_ERR_READ_INDEX, PROFILE_ERR_READ_PROFILES_DIR, PROFILE_ERR_REFRESHED_ACCESS_MISSING,
    PROFILE_ERR_REMOVE_INVALID, PROFILE_ERR_RENAME_PROFILE, PROFILE_ERR_SELECTED_INVALID,
    PROFILE_ERR_SERIALIZE_INDEX, PROFILE_ERR_SYNC_CURRENT, PROFILE_ERR_TTY_REQUIRED,
    PROFILE_ERR_WRITE_INDEX, PROFILE_LOAD_HELP, PROFILE_MSG_DELETED_COUNT,
    PROFILE_MSG_DELETED_WITH, PROFILE_MSG_LOADED_WITH, PROFILE_MSG_NOT_FOUND,
    PROFILE_MSG_REMOVED_INVALID, PROFILE_MSG_SAVED, PROFILE_MSG_SAVED_WITH, PROFILE_PROMPT_CANCEL,
    PROFILE_PROMPT_CONTINUE_WITHOUT_SAVING, PROFILE_PROMPT_DELETE_MANY, PROFILE_PROMPT_DELETE_ONE,
    PROFILE_PROMPT_DELETE_SELECTED, PROFILE_PROMPT_SAVE_AND_CONTINUE, PROFILE_STATUS_API_HIDDEN,
    PROFILE_STATUS_ERROR_HIDDEN, PROFILE_SUMMARY_AUTH_ERROR, PROFILE_SUMMARY_ERROR,
    PROFILE_SUMMARY_FILE_MISSING, PROFILE_SUMMARY_USAGE_ERROR, PROFILE_UNSAVED_NO_MATCH,
    PROFILE_WARN_CURRENT_NOT_SAVED_REASON, UI_ERROR_PREFIX, UI_ERROR_TWO_LINE,
};
use crate::{
    CANCELLED_MESSAGE, format_action, format_entry_header, format_error, format_list_hint,
    format_no_profiles, format_save_before_load, format_unsaved_warning, format_warning,
    inquire_select_render_config, is_inquire_cancel, is_plain, normalize_error, print_output_block,
    style_text, use_color_stderr, use_color_stdout,
};
use crate::{
    Paths, USAGE_UNAVAILABLE_API_KEY_DETAIL, USAGE_UNAVAILABLE_API_KEY_TITLE, command_name,
    copy_atomic, write_atomic,
};
use crate::{
    ProfileIdentityKey, Tokens, extract_email_and_plan, extract_profile_identity,
    is_api_key_profile, is_free_plan, is_profile_ready, profile_error, read_tokens,
    read_tokens_opt, refresh_profile_tokens, require_identity, token_account_id,
};
use crate::{
    UsageLock, fetch_usage_details, format_usage_unavailable, lock_usage, read_base_url,
    usage_unavailable,
};

const MAX_USAGE_CONCURRENCY: usize = 4;

pub fn save_profile(paths: &Paths, label: Option<String>) -> Result<(), String> {
    let use_color = use_color_stdout();
    let mut store = ProfileStore::load(paths)?;
    let tokens = read_tokens(&paths.auth)?;
    let id = resolve_save_id(paths, &mut store.profiles_index, &tokens)?;

    if let Some(label) = label.as_deref() {
        assign_label(&mut store.labels, label, &id)?;
    }

    let target = profile_path_for_id(&paths.profiles, &id);
    copy_profile(&paths.auth, &target, PROFILE_COPY_CONTEXT_SAVE)?;

    let label_display = label_for_id(&store.labels, &id);
    update_profiles_index_entry(
        &mut store.profiles_index,
        &id,
        Some(&tokens),
        label_display.clone(),
    );
    store.save(paths)?;

    let info = profile_info(Some(&tokens), label_display, true, use_color);
    let message = if info.email.is_some() {
        crate::msg1(PROFILE_MSG_SAVED_WITH, info.display)
    } else {
        PROFILE_MSG_SAVED.to_string()
    };
    let message = format_action(&message, use_color);
    print_output_block(&message);
    Ok(())
}

pub fn load_profile(paths: &Paths, label: Option<String>) -> Result<(), String> {
    let use_color_err = use_color_stderr();
    let use_color_out = use_color_stdout();
    let no_profiles = format_no_profiles(paths, use_color_err);
    let (mut snapshot, mut ordered) = load_snapshot_ordered(paths, true, &no_profiles)?;

    if let Some(reason) = unsaved_reason(paths, &snapshot.tokens)? {
        match prompt_unsaved_load(paths, &reason)? {
            LoadChoice::SaveAndContinue => {
                save_profile(paths, None)?;
                let no_profiles = format_no_profiles(paths, use_color_err);
                let result = load_snapshot_ordered(paths, true, &no_profiles)?;
                snapshot = result.0;
                ordered = result.1;
            }
            LoadChoice::ContinueWithoutSaving => {}
            LoadChoice::Cancel => {
                return Err(CANCELLED_MESSAGE.to_string());
            }
        }
    }

    let candidates = make_candidates(paths, &snapshot, &ordered);
    let selected = pick_one("load", label.as_deref(), &snapshot, &candidates)?;
    let selected_id = selected.id.clone();
    let selected_display = selected.display.clone();

    match snapshot.tokens.get(&selected_id) {
        Some(Ok(_)) => {}
        Some(Err(err)) => {
            let message = err
                .strip_prefix(&format!("{} ", UI_ERROR_PREFIX))
                .unwrap_or(err);
            return Err(crate::msg1(PROFILE_ERR_SELECTED_INVALID, message));
        }
        None => {
            return Err(profile_not_found(use_color_err));
        }
    }

    let mut store = ProfileStore::load(paths)?;

    if let Err(err) = sync_current(paths, &mut store.profiles_index) {
        let warning = format_warning(&err, use_color_err);
        eprintln!("{warning}");
    }

    let source = profile_path_for_id(&paths.profiles, &selected_id);
    if !source.is_file() {
        return Err(profile_not_found(use_color_err));
    }

    copy_profile(&source, &paths.auth, PROFILE_COPY_CONTEXT_LOAD)?;

    let label = label_for_id(&store.labels, &selected_id);
    let tokens = snapshot
        .tokens
        .get(&selected_id)
        .and_then(|result| result.as_ref().ok());
    update_profiles_index_entry(&mut store.profiles_index, &selected_id, tokens, label);
    store.save(paths)?;

    let message = format_action(
        &crate::msg1(PROFILE_MSG_LOADED_WITH, selected_display),
        use_color_out,
    );
    print_output_block(&message);
    Ok(())
}

pub fn delete_profile(paths: &Paths, yes: bool, label: Option<String>) -> Result<(), String> {
    let use_color_out = use_color_stdout();
    let use_color_err = use_color_stderr();
    let no_profiles = format_no_profiles(paths, use_color_out);
    let (snapshot, ordered) = match load_snapshot_ordered(paths, true, &no_profiles) {
        Ok(result) => result,
        Err(message) => {
            if message == no_profiles {
                print_output_block(&message);
                return Ok(());
            }
            return Err(message);
        }
    };

    let candidates = make_candidates(paths, &snapshot, &ordered);
    let selections = pick_many("delete", label.as_deref(), &snapshot, &candidates)?;
    let (selected_ids, displays): (Vec<String>, Vec<String>) = selections
        .iter()
        .map(|item| (item.id.clone(), item.display.clone()))
        .unzip();

    if selected_ids.is_empty() {
        return Ok(());
    }

    let mut store = ProfileStore::load(paths)?;
    if !yes && !confirm_delete_profiles(&displays)? {
        return Err(CANCELLED_MESSAGE.to_string());
    }

    for selected in &selected_ids {
        let target = profile_path_for_id(&paths.profiles, selected);
        if !target.is_file() {
            return Err(profile_not_found(use_color_err));
        }
        fs::remove_file(&target).map_err(|err| crate::msg1(PROFILE_ERR_FAILED_DELETE, err))?;
        remove_labels_for_id(&mut store.labels, selected);
        store.profiles_index.profiles.remove(selected);
    }
    store.save(paths)?;

    let message = if selected_ids.len() == 1 {
        crate::msg1(PROFILE_MSG_DELETED_WITH, &displays[0])
    } else {
        crate::msg1(PROFILE_MSG_DELETED_COUNT, selected_ids.len())
    };
    let message = format_action(&message, use_color_out);
    print_output_block(&message);
    Ok(())
}

pub fn list_profiles(paths: &Paths) -> Result<(), String> {
    let snapshot = load_snapshot(paths, false)?;
    let current_saved_id = current_saved_id(paths, &snapshot.tokens);
    let ctx = ListCtx::new(paths, false);

    let ordered = ordered_from_tokens(&snapshot.tokens);
    let current_entry = make_current(
        paths,
        current_saved_id.as_deref(),
        &snapshot.labels,
        &snapshot.tokens,
        &ctx,
    );
    let has_saved = !ordered.is_empty();
    if !has_saved {
        if let Some(entry) = current_entry {
            let lines = render_entries(&[entry], &ctx, false);
            print_output_block(&lines.join("\n"));
        } else {
            let message = format_no_profiles(paths, ctx.use_color);
            print_output_block(&message);
        }
        return Ok(());
    }

    let filtered: Vec<String> = ordered
        .into_iter()
        .filter(|id| current_saved_id.as_deref() != Some(id.as_str()))
        .collect();
    let list_entries = make_entries(&filtered, &snapshot, None, &ctx);

    let mut lines = Vec::new();
    if let Some(entry) = current_entry {
        lines.extend(render_entries(&[entry], &ctx, false));
        if !list_entries.is_empty() {
            push_separator(&mut lines, false);
        }
    }
    lines.extend(render_entries(&list_entries, &ctx, false));
    let output = lines.join("\n");
    print_output_block(&output);
    Ok(())
}

pub fn status_profiles(paths: &Paths, all: bool, show_errors: bool) -> Result<(), String> {
    if all {
        return status_all_profiles(paths, show_errors);
    }
    let snapshot = load_snapshot(paths, false).ok();
    let current_saved_id = snapshot
        .as_ref()
        .and_then(|snap| current_saved_id(paths, &snap.tokens));
    let ctx = ListCtx::new(paths, true);
    let empty_labels = Labels::new();
    let labels = snapshot
        .as_ref()
        .map(|snap| &snap.labels)
        .unwrap_or(&empty_labels);
    let empty_tokens = BTreeMap::new();
    let tokens_map = snapshot
        .as_ref()
        .map(|snap| &snap.tokens)
        .unwrap_or(&empty_tokens);
    let current_entry = make_current(paths, current_saved_id.as_deref(), labels, tokens_map, &ctx);
    if let Some(entry) = current_entry {
        let lines = render_entries(&[entry], &ctx, false);
        print_output_block(&lines.join("\n"));
    } else {
        let message = format_no_profiles(paths, ctx.use_color);
        print_output_block(&message);
    }
    Ok(())
}

fn status_all_profiles(paths: &Paths, show_errors: bool) -> Result<(), String> {
    let snapshot = load_snapshot(paths, false)?;
    let current_saved_id = current_saved_id(paths, &snapshot.tokens);
    let ctx = ListCtx::new(paths, true);

    let ordered = ordered_from_tokens(&snapshot.tokens);
    let current_entry = make_current(
        paths,
        current_saved_id.as_deref(),
        &snapshot.labels,
        &snapshot.tokens,
        &ctx,
    );
    let filtered: Vec<String> = ordered
        .into_iter()
        .filter(|id| current_saved_id.as_deref() != Some(id.as_str()))
        .collect();

    let mut hidden_api_count = 0usize;
    let mut hidden_error_count = 0usize;
    let mut list_entries = Vec::new();
    let labels_by_id = labels_by_id(&snapshot.labels);
    for id in filtered {
        if is_api_saved_profile(&id, &snapshot) {
            hidden_api_count += 1;
            continue;
        }
        let entry = make_saved(&id, &snapshot, &labels_by_id, None, &ctx);
        if !show_errors && entry.error_summary.is_some() {
            hidden_error_count += 1;
            continue;
        }
        list_entries.push(entry);
    }

    let mut current_visible = None;
    if let Some(entry) = current_entry {
        let current_is_api = read_tokens_opt(&paths.auth)
            .map(|tokens| is_api_key_profile(&tokens))
            .unwrap_or(false);
        if current_is_api {
            hidden_api_count += 1;
        } else if !show_errors && entry.error_summary.is_some() {
            hidden_error_count += 1;
        } else {
            current_visible = Some(entry);
        }
    }

    if current_visible.is_none()
        && list_entries.is_empty()
        && hidden_api_count == 0
        && hidden_error_count == 0
    {
        let message = format_no_profiles(paths, ctx.use_color);
        print_output_block(&message);
        return Ok(());
    }

    let mut lines = Vec::new();
    if let Some(entry) = current_visible {
        lines.extend(render_entries(&[entry], &ctx, true));
        if !list_entries.is_empty() || hidden_api_count > 0 || hidden_error_count > 0 {
            push_separator(&mut lines, true);
        }
    }

    if !list_entries.is_empty() {
        lines.extend(render_entries(&list_entries, &ctx, true));
        if hidden_api_count > 0 || hidden_error_count > 0 {
            push_separator(&mut lines, true);
        }
    }

    if hidden_api_count > 0 {
        let hidden_message = crate::msg1(PROFILE_STATUS_API_HIDDEN, hidden_api_count);
        lines.push(style_text(&hidden_message, ctx.use_color, |text| {
            text.dimmed().italic()
        }));
    }
    if hidden_error_count > 0 {
        let hidden_message = crate::msg1(PROFILE_STATUS_ERROR_HIDDEN, hidden_error_count);
        lines.push(style_text(&hidden_message, ctx.use_color, |text| {
            text.dimmed().italic()
        }));
    }

    let output = lines.join("\n");
    print_output_block(&output);
    Ok(())
}

pub type Labels = BTreeMap<String, String>;

const PROFILES_INDEX_VERSION: u8 = 2;

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ProfilesIndex {
    #[serde(default = "profiles_index_version")]
    version: u8,
    #[serde(default)]
    profiles: BTreeMap<String, ProfileIndexEntry>,
}

impl Default for ProfilesIndex {
    fn default() -> Self {
        Self {
            version: PROFILES_INDEX_VERSION,
            profiles: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProfileIndexEntry {
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    is_api_key: bool,
    #[serde(default)]
    principal_id: Option<String>,
    #[serde(default)]
    workspace_or_org_id: Option<String>,
    #[serde(default)]
    plan_type_key: Option<String>,
}

fn profiles_index_version() -> u8 {
    PROFILES_INDEX_VERSION
}

pub(crate) fn read_profiles_index(paths: &Paths) -> Result<ProfilesIndex, String> {
    if !paths.profiles_index.exists() {
        return Ok(ProfilesIndex::default());
    }
    let contents = fs::read_to_string(&paths.profiles_index)
        .map_err(|err| crate::msg2(PROFILE_ERR_READ_INDEX, paths.profiles_index.display(), err))?;
    let had_legacy_schema = contents.contains("\"last_used\"")
        || contents.contains("\"active_profile_id\"")
        || contents.contains("\"update_cache\"");
    let mut index: ProfilesIndex = serde_json::from_str(&contents).map_err(|_| {
        crate::msg1(
            PROFILE_ERR_INDEX_INVALID_JSON,
            paths.profiles_index.display(),
        )
    })?;
    if index.version < PROFILES_INDEX_VERSION {
        index.version = PROFILES_INDEX_VERSION;
    }
    if had_legacy_schema {
        let _ = write_profiles_index(paths, &index);
    }
    Ok(index)
}

pub(crate) fn read_profiles_index_relaxed(paths: &Paths) -> ProfilesIndex {
    match read_profiles_index(paths) {
        Ok(index) => index,
        Err(err) => {
            let normalized = normalize_error(&err);
            let warning = format_warning(&normalized, use_color_stderr());
            eprintln!("{warning}");
            ProfilesIndex::default()
        }
    }
}

pub(crate) fn write_profiles_index(paths: &Paths, index: &ProfilesIndex) -> Result<(), String> {
    let json = serde_json::to_string_pretty(index)
        .map_err(|err| crate::msg1(PROFILE_ERR_SERIALIZE_INDEX, err))?;
    write_atomic(&paths.profiles_index, format!("{json}\n").as_bytes())
        .map_err(|err| crate::msg1(PROFILE_ERR_WRITE_INDEX, err))
}

fn prune_profiles_index(index: &mut ProfilesIndex, profiles_dir: &Path) -> Result<(), String> {
    let ids = collect_profile_ids(profiles_dir)?;
    index.profiles.retain(|id, _| ids.contains(id));
    Ok(())
}

fn sync_profiles_index(index: &mut ProfilesIndex, labels: &Labels) {
    for (id, entry) in index.profiles.iter_mut() {
        entry.label = label_for_id(labels, id);
    }
}

fn labels_from_index(index: &ProfilesIndex) -> Labels {
    let mut labels = Labels::new();
    for (id, entry) in &index.profiles {
        let Some(label) = entry.label.as_deref() else {
            continue;
        };
        let trimmed = label.trim();
        if trimmed.is_empty() || labels.contains_key(trimmed) {
            continue;
        }
        labels.insert(trimmed.to_string(), id.clone());
    }
    labels
}

fn update_profiles_index_entry(
    index: &mut ProfilesIndex,
    id: &str,
    tokens: Option<&Tokens>,
    label: Option<String>,
) {
    let entry = index.profiles.entry(id.to_string()).or_default();
    if let Some(tokens) = tokens {
        let (email, plan) = extract_email_and_plan(tokens);
        entry.email = email;
        entry.plan = plan;
        entry.account_id = token_account_id(tokens).map(str::to_string);
        entry.is_api_key = is_api_key_profile(tokens);
        if let Some(identity) = extract_profile_identity(tokens) {
            entry.principal_id = Some(identity.principal_id);
            entry.workspace_or_org_id = Some(identity.workspace_or_org_id);
            entry.plan_type_key = Some(identity.plan_type);
        }
    }
    if let Some(label) = label {
        entry.label = Some(label);
    }
}

pub fn prune_labels(labels: &mut Labels, profiles_dir: &Path) {
    labels.retain(|_, id| profile_path_for_id(profiles_dir, id).is_file());
}

pub fn assign_label(labels: &mut Labels, label: &str, id: &str) -> Result<(), String> {
    let trimmed = trim_label(label)?;
    if let Some(existing) = labels.get(trimmed) {
        if existing == id {
            return Ok(());
        }
        return Err(crate::msg2(
            PROFILE_ERR_LABEL_EXISTS,
            trimmed,
            format_list_hint(use_color_stderr()),
        ));
    }
    labels.insert(trimmed.to_string(), id.to_string());
    Ok(())
}

pub fn remove_labels_for_id(labels: &mut Labels, id: &str) {
    labels.retain(|_, value| value != id);
}

pub fn label_for_id(labels: &Labels, id: &str) -> Option<String> {
    labels.iter().find_map(|(label, value)| {
        if value == id {
            Some(label.clone())
        } else {
            None
        }
    })
}

fn labels_by_id(labels: &Labels) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (label, id) in labels {
        out.entry(id.clone()).or_insert_with(|| label.clone());
    }
    out
}

pub fn resolve_label_id(labels: &Labels, label: &str) -> Result<String, String> {
    let trimmed = trim_label(label)?;
    labels.get(trimmed).cloned().ok_or_else(|| {
        crate::msg2(
            PROFILE_ERR_LABEL_NOT_FOUND,
            trimmed,
            format_list_hint(use_color_stderr()),
        )
    })
}

pub fn profile_files(profiles_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    if !profiles_dir.exists() {
        return Ok(files);
    }
    let entries = fs::read_dir(profiles_dir)
        .map_err(|err| crate::msg1(PROFILE_ERR_READ_PROFILES_DIR, err))?;
    for entry in entries {
        let entry = entry.map_err(|err| crate::msg1(PROFILE_ERR_READ_PROFILES_DIR, err))?;
        let path = entry.path();
        if !is_profile_file(&path) {
            continue;
        }
        files.push(path);
    }
    Ok(files)
}

pub fn profile_id_from_path(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|stem| !stem.is_empty())
        .map(|stem| stem.to_string())
}

pub fn profile_path_for_id(profiles_dir: &Path, id: &str) -> PathBuf {
    profiles_dir.join(format!("{id}.json"))
}

pub fn collect_profile_ids(profiles_dir: &Path) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for path in profile_files(profiles_dir)? {
        if let Some(stem) = profile_id_from_path(&path) {
            ids.insert(stem);
        }
    }
    Ok(ids)
}

pub fn load_profile_tokens_map(
    paths: &Paths,
) -> Result<BTreeMap<String, Result<Tokens, String>>, String> {
    let mut map = BTreeMap::new();
    let mut removed_ids: Vec<String> = Vec::new();
    for path in profile_files(&paths.profiles)? {
        let Some(stem) = profile_id_from_path(&path) else {
            continue;
        };
        match read_tokens(&path) {
            Ok(tokens) => {
                map.insert(stem, Ok(tokens));
            }
            Err(err) => {
                let id = stem.clone();
                if let Err(remove_err) = fs::remove_file(&path) {
                    let message =
                        crate::msg2(PROFILE_ERR_REMOVE_INVALID, path.display(), remove_err);
                    map.insert(id, Err(message));
                } else {
                    removed_ids.push(id);
                    let summary = normalize_error(&err);
                    eprintln!(
                        "{}",
                        format_warning(
                            &crate::msg2(PROFILE_MSG_REMOVED_INVALID, path.display(), summary),
                            use_color_stderr()
                        )
                    );
                }
            }
        }
    }
    if !removed_ids.is_empty() {
        let mut index = read_profiles_index_relaxed(paths);
        for id in &removed_ids {
            index.profiles.remove(id);
        }
        let _ = write_profiles_index(paths, &index);
    }
    Ok(map)
}

pub(crate) fn resolve_save_id(
    paths: &Paths,
    profiles_index: &mut ProfilesIndex,
    tokens: &Tokens,
) -> Result<String, String> {
    let (_, email, plan) = require_identity(tokens)?;
    let identity =
        extract_profile_identity(tokens).ok_or_else(|| AUTH_ERR_INCOMPLETE_ACCOUNT.to_string())?;
    let (desired_base, desired, candidates) = desired_candidates(paths, &identity, &email, &plan)?;
    if let Some(primary) = pick_primary(&candidates).filter(|primary| primary != &desired) {
        return rename_profile_id(paths, profiles_index, &primary, &desired_base, &identity);
    }
    Ok(desired)
}

pub(crate) fn resolve_sync_id(
    paths: &Paths,
    profiles_index: &mut ProfilesIndex,
    tokens: &Tokens,
) -> Result<Option<String>, String> {
    let Ok((_, email, plan)) = require_identity(tokens) else {
        return Ok(None);
    };
    let Some(identity) = extract_profile_identity(tokens) else {
        return Ok(None);
    };
    let (desired_base, desired, candidates) = desired_candidates(paths, &identity, &email, &plan)?;
    if candidates.len() == 1 {
        return Ok(candidates.first().cloned());
    }
    if candidates.iter().any(|id| id == &desired) {
        return Ok(Some(desired));
    }
    let Some(primary) = pick_primary(&candidates) else {
        return Ok(None);
    };
    if primary != desired {
        let renamed = rename_profile_id(paths, profiles_index, &primary, &desired_base, &identity)?;
        return Ok(Some(renamed));
    }
    Ok(Some(primary))
}

pub(crate) fn cached_profile_ids(
    tokens_map: &BTreeMap<String, Result<Tokens, String>>,
    identity: &ProfileIdentityKey,
) -> Vec<String> {
    tokens_map
        .iter()
        .filter_map(|(id, result)| {
            result
                .as_ref()
                .ok()
                .filter(|tokens| matches_identity(tokens, identity))
                .map(|_| id.clone())
        })
        .collect()
}

pub(crate) fn pick_primary(candidates: &[String]) -> Option<String> {
    candidates.iter().min().cloned()
}

fn desired_candidates(
    paths: &Paths,
    identity: &ProfileIdentityKey,
    email: &str,
    plan: &str,
) -> Result<(String, String, Vec<String>), String> {
    let (desired_base, desired) = desired_id(paths, identity, email, plan);
    let candidates = scan_profile_ids(&paths.profiles, identity)?;
    Ok((desired_base, desired, candidates))
}

fn desired_id(
    paths: &Paths,
    identity: &ProfileIdentityKey,
    email: &str,
    plan: &str,
) -> (String, String) {
    let desired_base = profile_base(email, plan);
    let desired = unique_id(&desired_base, identity, &paths.profiles);
    (desired_base, desired)
}

fn profile_base(email: &str, plan_label: &str) -> String {
    let email = sanitize_part(email);
    let plan = sanitize_part(plan_label);
    let email = if email.is_empty() {
        "unknown".to_string()
    } else {
        email
    };
    let plan = if plan.is_empty() {
        "unknown".to_string()
    } else {
        plan
    };
    format!("{email}-{plan}")
}

fn sanitize_part(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_dash = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if matches!(ch, '@' | '.' | '-' | '_' | '+') {
            Some(ch)
        } else {
            Some('-')
        };
        if let Some(next) = next {
            if next == '-' {
                if last_dash {
                    continue;
                }
                last_dash = true;
            } else {
                last_dash = false;
            }
            out.push(next);
        }
    }
    out.trim_matches('-').to_string()
}

fn unique_id(base: &str, identity: &ProfileIdentityKey, profiles_dir: &Path) -> String {
    let mut candidate = base.to_string();
    let suffix = short_identity_suffix(identity);
    let mut attempts = 0usize;
    loop {
        let path = profile_path_for_id(profiles_dir, &candidate);
        if !path.is_file() {
            return candidate;
        }
        if read_tokens(&path)
            .ok()
            .is_some_and(|tokens| matches_identity(&tokens, identity))
        {
            return candidate;
        }
        attempts += 1;
        if attempts == 1 {
            candidate = format!("{base}-{suffix}");
        } else {
            candidate = format!("{base}-{suffix}-{attempts}");
        }
    }
}

fn short_identity_suffix(identity: &ProfileIdentityKey) -> String {
    let source = if identity.workspace_or_org_id == "unknown" {
        identity.principal_id.as_str()
    } else {
        identity.workspace_or_org_id.as_str()
    };
    let suffix: String = source.chars().take(6).collect();
    if suffix.is_empty() {
        "id".to_string()
    } else {
        suffix
    }
}

fn scan_profile_ids(
    profiles_dir: &Path,
    identity: &ProfileIdentityKey,
) -> Result<Vec<String>, String> {
    let mut matches = Vec::new();
    for path in profile_files(profiles_dir)? {
        let Ok(tokens) = read_tokens(&path) else {
            continue;
        };
        if !matches_identity(&tokens, identity) {
            continue;
        }
        if let Some(stem) = profile_id_from_path(&path) {
            matches.push(stem);
        }
    }
    Ok(matches)
}

fn matches_identity(tokens: &Tokens, identity: &ProfileIdentityKey) -> bool {
    extract_profile_identity(tokens).is_some_and(|candidate| candidate == *identity)
}

fn rename_profile_id(
    paths: &Paths,
    profiles_index: &mut ProfilesIndex,
    from: &str,
    target_base: &str,
    identity: &ProfileIdentityKey,
) -> Result<String, String> {
    let desired = unique_id(target_base, identity, &paths.profiles);
    if from == desired {
        return Ok(desired);
    }
    let from_path = profile_path_for_id(&paths.profiles, from);
    let to_path = profile_path_for_id(&paths.profiles, &desired);
    if !from_path.is_file() {
        return Err(crate::msg1(PROFILE_ERR_ID_NOT_FOUND, from));
    }
    fs::rename(&from_path, &to_path)
        .map_err(|err| crate::msg2(PROFILE_ERR_RENAME_PROFILE, from, err))?;
    if let Some(entry) = profiles_index.profiles.remove(from) {
        profiles_index.profiles.insert(desired.clone(), entry);
    }
    Ok(desired)
}

pub(crate) struct Snapshot {
    pub(crate) labels: Labels,
    pub(crate) tokens: BTreeMap<String, Result<Tokens, String>>,
    pub(crate) index: ProfilesIndex,
}

pub(crate) fn sync_current(paths: &Paths, index: &mut ProfilesIndex) -> Result<(), String> {
    let Some(tokens) = read_tokens_opt(&paths.auth) else {
        return Ok(());
    };
    let id = match resolve_sync_id(paths, index, &tokens)? {
        Some(id) => id,
        None => return Ok(()),
    };
    let target = profile_path_for_id(&paths.profiles, &id);
    sync_profile(paths, &target)?;
    let label = label_for_id(&labels_from_index(index), &id);
    update_profiles_index_entry(index, &id, Some(&tokens), label);
    Ok(())
}

fn sync_profile(paths: &Paths, target: &Path) -> Result<(), String> {
    copy_atomic(&paths.auth, target).map_err(|err| crate::msg1(PROFILE_ERR_SYNC_CURRENT, err))?;
    Ok(())
}

pub(crate) fn load_snapshot(paths: &Paths, strict_labels: bool) -> Result<Snapshot, String> {
    let _lock = lock_usage(paths)?;
    let tokens = load_profile_tokens_map(paths)?;
    let ids: HashSet<String> = tokens.keys().cloned().collect();
    let mut index = if strict_labels {
        read_profiles_index(paths)?
    } else {
        read_profiles_index_relaxed(paths)
    };
    let _ = prune_profiles_index(&mut index, &paths.profiles);
    for id in &ids {
        index.profiles.entry(id.clone()).or_default();
    }
    let labels = labels_from_index(&index);

    Ok(Snapshot {
        labels,
        tokens,
        index,
    })
}

pub(crate) fn unsaved_reason(
    paths: &Paths,
    tokens_map: &BTreeMap<String, Result<Tokens, String>>,
) -> Result<Option<String>, String> {
    let Some(tokens) = read_tokens_opt(&paths.auth) else {
        return Ok(None);
    };
    let Some(identity) = extract_profile_identity(&tokens) else {
        return Ok(None);
    };
    let candidates = cached_profile_ids(tokens_map, &identity);
    if candidates.is_empty() {
        return Ok(Some(PROFILE_UNSAVED_NO_MATCH.to_string()));
    }
    Ok(None)
}

pub(crate) fn current_saved_id(
    paths: &Paths,
    tokens_map: &BTreeMap<String, Result<Tokens, String>>,
) -> Option<String> {
    let tokens = read_tokens_opt(&paths.auth)?;
    let identity = extract_profile_identity(&tokens)?;
    let candidates = cached_profile_ids(tokens_map, &identity);
    pick_primary(&candidates)
}

pub(crate) struct ProfileStore {
    _lock: UsageLock,
    pub(crate) labels: Labels,
    pub(crate) profiles_index: ProfilesIndex,
}

impl ProfileStore {
    pub(crate) fn load(paths: &Paths) -> Result<Self, String> {
        let lock = lock_usage(paths)?;
        let mut profiles_index = read_profiles_index_relaxed(paths);
        let _ = prune_profiles_index(&mut profiles_index, &paths.profiles);
        let ids = collect_profile_ids(&paths.profiles)?;
        for id in &ids {
            profiles_index.profiles.entry(id.clone()).or_default();
        }
        let labels = labels_from_index(&profiles_index);
        Ok(Self {
            _lock: lock,
            labels,
            profiles_index,
        })
    }

    pub(crate) fn save(&mut self, paths: &Paths) -> Result<(), String> {
        prune_labels(&mut self.labels, &paths.profiles);
        prune_profiles_index(&mut self.profiles_index, &paths.profiles)?;
        sync_profiles_index(&mut self.profiles_index, &self.labels);
        write_profiles_index(paths, &self.profiles_index)?;
        Ok(())
    }
}

fn profile_not_found(use_color: bool) -> String {
    crate::msg1(PROFILE_MSG_NOT_FOUND, format_list_hint(use_color))
}

fn load_snapshot_ordered(
    paths: &Paths,
    strict_labels: bool,
    no_profiles_message: &str,
) -> Result<(Snapshot, Vec<String>), String> {
    let snapshot = load_snapshot(paths, strict_labels)?;
    let ordered = ordered_from_tokens(&snapshot.tokens);
    if ordered.is_empty() {
        return Err(no_profiles_message.to_string());
    }
    Ok((snapshot, ordered))
}

fn ordered_from_tokens(tokens_map: &BTreeMap<String, Result<Tokens, String>>) -> Vec<String> {
    tokens_map.keys().cloned().collect()
}

fn copy_profile(source: &Path, dest: &Path, context: &str) -> Result<(), String> {
    copy_atomic(source, dest)
        .map_err(|err| crate::msg3(PROFILE_ERR_COPY_CONTEXT, context, dest.display(), err))?;
    Ok(())
}

fn make_candidates(paths: &Paths, snapshot: &Snapshot, ordered: &[String]) -> Vec<Candidate> {
    let current_saved = current_saved_id(paths, &snapshot.tokens);
    build_candidates(ordered, snapshot, current_saved.as_deref())
}

fn pick_one(
    action: &str,
    label: Option<&str>,
    snapshot: &Snapshot,
    candidates: &[Candidate],
) -> Result<Candidate, String> {
    if let Some(label) = label {
        select_by_label(label, &snapshot.labels, candidates)
    } else {
        require_tty(action)?;
        select_single_profile("", candidates)
    }
}

fn pick_many(
    action: &str,
    label: Option<&str>,
    snapshot: &Snapshot,
    candidates: &[Candidate],
) -> Result<Vec<Candidate>, String> {
    if let Some(label) = label {
        Ok(vec![select_by_label(label, &snapshot.labels, candidates)?])
    } else {
        require_tty(action)?;
        select_multiple_profiles("", candidates)
    }
}

pub(crate) struct ProfileInfo {
    pub(crate) display: String,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
    pub(crate) is_free: bool,
}

pub(crate) fn profile_info(
    tokens: Option<&Tokens>,
    label: Option<String>,
    is_current: bool,
    use_color: bool,
) -> ProfileInfo {
    profile_info_with_fallback(tokens, None, label, is_current, use_color)
}

fn profile_info_with_fallback(
    tokens: Option<&Tokens>,
    fallback: Option<&ProfileIndexEntry>,
    label: Option<String>,
    is_current: bool,
    use_color: bool,
) -> ProfileInfo {
    let (email, plan) = if let Some(tokens) = tokens {
        extract_email_and_plan(tokens)
    } else if let Some(entry) = fallback {
        (entry.email.clone(), entry.plan.clone())
    } else {
        (None, None)
    };
    let is_free = is_free_plan(plan.as_deref());
    let display =
        crate::format_profile_display(email.clone(), plan.clone(), label, is_current, use_color);
    ProfileInfo {
        display,
        email,
        plan,
        is_free,
    }
}

#[derive(Debug)]
pub(crate) enum LoadChoice {
    SaveAndContinue,
    ContinueWithoutSaving,
    Cancel,
}

pub(crate) fn prompt_unsaved_load(paths: &Paths, reason: &str) -> Result<LoadChoice, String> {
    let is_tty = io::stdin().is_terminal();
    if !is_tty {
        let hint = format_save_before_load(paths, use_color_stderr());
        return Err(crate::msg1(PROFILE_ERR_CURRENT_NOT_SAVED, hint));
    }
    let selection = Select::new(
        "",
        vec![
            PROFILE_PROMPT_SAVE_AND_CONTINUE,
            PROFILE_PROMPT_CONTINUE_WITHOUT_SAVING,
            PROFILE_PROMPT_CANCEL,
        ],
    )
    .with_render_config(inquire_select_render_config())
    .prompt();
    prompt_unsaved_load_with(paths, reason, is_tty, selection)
}

fn prompt_unsaved_load_with(
    paths: &Paths,
    reason: &str,
    is_tty: bool,
    selection: Result<&str, inquire::error::InquireError>,
) -> Result<LoadChoice, String> {
    if !is_tty {
        let hint = format_save_before_load(paths, use_color_stderr());
        return Err(crate::msg1(PROFILE_ERR_CURRENT_NOT_SAVED, hint));
    }
    let warning = format_warning(
        &crate::msg1(PROFILE_WARN_CURRENT_NOT_SAVED_REASON, reason),
        use_color_stderr(),
    );
    eprintln!("{warning}");
    match selection {
        Ok(PROFILE_PROMPT_SAVE_AND_CONTINUE) => Ok(LoadChoice::SaveAndContinue),
        Ok(PROFILE_PROMPT_CONTINUE_WITHOUT_SAVING) => Ok(LoadChoice::ContinueWithoutSaving),
        Ok(_) => Ok(LoadChoice::Cancel),
        Err(err) if is_inquire_cancel(&err) => Ok(LoadChoice::Cancel),
        Err(err) => Err(crate::msg1(PROFILE_ERR_PROMPT_LOAD, err)),
    }
}

pub(crate) fn build_candidates(
    ordered: &[String],
    snapshot: &Snapshot,
    current_saved_id: Option<&str>,
) -> Vec<Candidate> {
    let mut candidates = Vec::with_capacity(ordered.len());
    let use_color = use_color_stderr();
    let labels_by_id = labels_by_id(&snapshot.labels);
    for id in ordered {
        let label = labels_by_id.get(id).cloned();
        let tokens = snapshot
            .tokens
            .get(id)
            .and_then(|result| result.as_ref().ok());
        let index_entry = snapshot.index.profiles.get(id);
        let is_current = current_saved_id == Some(id.as_str());
        let info = profile_info_with_fallback(tokens, index_entry, label, is_current, use_color);
        candidates.push(Candidate {
            id: id.clone(),
            display: info.display,
        });
    }
    candidates
}

pub(crate) fn require_tty(action: &str) -> Result<(), String> {
    require_tty_with(io::stdin().is_terminal(), action)
}

fn require_tty_with(is_tty: bool, action: &str) -> Result<(), String> {
    if is_tty {
        Ok(())
    } else {
        Err(crate::msg3(
            PROFILE_ERR_TTY_REQUIRED,
            action,
            command_name(),
            action,
        ))
    }
}

pub(crate) fn select_single_profile(
    title: &str,
    candidates: &[Candidate],
) -> Result<Candidate, String> {
    let options = candidates.to_vec();
    let render_config = inquire_select_render_config();
    let prompt = Select::new(title, options)
        .with_help_message(PROFILE_LOAD_HELP)
        .with_render_config(render_config)
        .prompt();
    handle_inquire_result(prompt, "selection")
}

pub(crate) fn select_multiple_profiles(
    title: &str,
    candidates: &[Candidate],
) -> Result<Vec<Candidate>, String> {
    let options = candidates.to_vec();
    let render_config = inquire_select_render_config();
    let prompt = MultiSelect::new(title, options)
        .with_help_message(PROFILE_DELETE_HELP)
        .with_render_config(render_config)
        .prompt();
    let selections = handle_inquire_result(prompt, "selection")?;
    if selections.is_empty() {
        return Err(CANCELLED_MESSAGE.to_string());
    }
    Ok(selections)
}

pub(crate) fn select_by_label(
    label: &str,
    labels: &Labels,
    candidates: &[Candidate],
) -> Result<Candidate, String> {
    let id = resolve_label_id(labels, label)?;
    let Some(candidate) = candidates.iter().find(|candidate| candidate.id == id) else {
        return Err(crate::msg2(
            PROFILE_ERR_LABEL_NO_MATCH,
            label,
            format_list_hint(use_color_stderr()),
        ));
    };
    Ok(candidate.clone())
}

pub(crate) fn confirm_delete_profiles(displays: &[String]) -> Result<bool, String> {
    let is_tty = io::stdin().is_terminal();
    if !is_tty {
        return Err(PROFILE_ERR_DELETE_CONFIRM_REQUIRED.to_string());
    }
    let prompt = if displays.len() == 1 {
        crate::msg1(PROFILE_PROMPT_DELETE_ONE, &displays[0])
    } else {
        let count = displays.len();
        eprintln!("{}", crate::msg1(PROFILE_PROMPT_DELETE_MANY, count));
        for display in displays {
            eprintln!(" - {display}");
        }
        PROFILE_PROMPT_DELETE_SELECTED.to_string()
    };
    let selection = Confirm::new(&prompt)
        .with_default(false)
        .with_render_config(inquire_select_render_config())
        .prompt();
    confirm_delete_profiles_with(is_tty, selection)
}

fn confirm_delete_profiles_with(
    is_tty: bool,
    selection: Result<bool, inquire::error::InquireError>,
) -> Result<bool, String> {
    if !is_tty {
        return Err(PROFILE_ERR_DELETE_CONFIRM_REQUIRED.to_string());
    }
    match selection {
        Ok(value) => Ok(value),
        Err(err) if is_inquire_cancel(&err) => Err(CANCELLED_MESSAGE.to_string()),
        Err(err) => Err(crate::msg1(PROFILE_ERR_PROMPT_DELETE, err)),
    }
}

#[derive(Clone)]
pub(crate) struct Candidate {
    pub(crate) id: String,
    pub(crate) display: String,
}

impl fmt::Display for Candidate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let header = format_entry_header(&self.display, use_color_stderr());
        write!(f, "{header}")
    }
}

fn render_entries(entries: &[Entry], ctx: &ListCtx, allow_plain_spacing: bool) -> Vec<String> {
    let mut lines = Vec::with_capacity((entries.len().max(1)) * 4);
    for (idx, entry) in entries.iter().enumerate() {
        let header = format_entry_header(&entry.display, ctx.use_color);
        let show_detail_lines = ctx.show_usage || entry.always_show_details;
        if !show_detail_lines {
            if let Some(err) = entry.error_summary.as_deref() {
                let mut header = header;
                header.push_str(&format!("  {err}"));
                lines.push(header);
            } else {
                lines.push(header);
            }
        } else {
            lines.push(header);
            lines.extend(entry.details.iter().cloned());
        }
        if idx + 1 < entries.len() {
            push_separator(&mut lines, allow_plain_spacing);
        }
    }
    lines
}

fn push_separator(lines: &mut Vec<String>, allow_plain_spacing: bool) {
    if !is_plain() || allow_plain_spacing {
        lines.push(String::new());
    }
}

fn make_error(
    label: Option<String>,
    index_entry: Option<&ProfileIndexEntry>,
    use_color: bool,
    message: &str,
    summary_label: &str,
    is_current: bool,
) -> Entry {
    let display =
        profile_info_with_fallback(None, index_entry, label, is_current, use_color).display;
    Entry {
        display,
        details: vec![format_error(message)],
        error_summary: Some(error_summary(summary_label, message)),
        always_show_details: false,
    }
}

fn unavailable_lines(message: &str, use_color: bool) -> Vec<String> {
    vec![format_usage_unavailable(message, use_color)]
}

fn detail_lines(
    tokens: &mut Tokens,
    email: Option<&str>,
    plan: Option<&str>,
    profile_path: &Path,
    ctx: &ListCtx,
) -> (Vec<String>, Option<String>, bool) {
    let use_color = ctx.use_color;
    let account_id = token_account_id(tokens).map(str::to_string);
    let access_token = tokens.access_token.clone();
    if is_api_key_profile(tokens) {
        if ctx.show_usage {
            return (
                vec![format_error(&crate::msg2(
                    UI_ERROR_TWO_LINE,
                    USAGE_UNAVAILABLE_API_KEY_TITLE,
                    USAGE_UNAVAILABLE_API_KEY_DETAIL,
                ))],
                None,
                false,
            );
        }
        return (Vec::new(), None, false);
    }
    let unavailable_text = usage_unavailable();
    if let Some(message) = profile_error(tokens, email, plan) {
        let missing_access = access_token.is_none() || account_id.is_none();
        let missing_identity_only =
            message == AUTH_ERR_PROFILE_MISSING_EMAIL_PLAN && !missing_access;
        if !missing_identity_only {
            if ctx.show_usage && missing_access && email.is_some() && plan.is_some() {
                return (unavailable_lines(unavailable_text, use_color), None, false);
            }
            let details = vec![format_error(message)];
            let summary = Some(error_summary(PROFILE_SUMMARY_ERROR, message));
            return (details, summary, false);
        }
    }
    if ctx.show_usage {
        let Some(base_url) = ctx.base_url.as_deref() else {
            return (Vec::new(), None, false);
        };
        let Some(access_token) = access_token.as_deref() else {
            return (Vec::new(), None, false);
        };
        let Some(account_id) = account_id.as_deref() else {
            return (Vec::new(), None, false);
        };
        match fetch_usage_details(
            base_url,
            access_token,
            account_id,
            unavailable_text,
            ctx.now,
        ) {
            Ok(details) => (details, None, false),
            Err(err) if err.status_code() == Some(401) => {
                match refresh_profile_tokens(profile_path, tokens) {
                    Ok(()) => {
                        let Some(access_token) = tokens.access_token.as_deref() else {
                            let message = PROFILE_ERR_REFRESHED_ACCESS_MISSING;
                            return (
                                vec![format_error(message)],
                                Some(error_summary(PROFILE_SUMMARY_AUTH_ERROR, message)),
                                true,
                            );
                        };
                        match fetch_usage_details(
                            base_url,
                            access_token,
                            account_id,
                            unavailable_text,
                            ctx.now,
                        ) {
                            Ok(details) => (details, None, true),
                            Err(err) => (
                                vec![format_error(&err.message())],
                                Some(error_summary(PROFILE_SUMMARY_USAGE_ERROR, &err.message())),
                                true,
                            ),
                        }
                    }
                    Err(err) => (
                        vec![format_error(&err)],
                        Some(error_summary(PROFILE_SUMMARY_AUTH_ERROR, &err)),
                        false,
                    ),
                }
            }
            Err(err) => (
                vec![format_error(&err.message())],
                Some(error_summary(PROFILE_SUMMARY_USAGE_ERROR, &err.message())),
                false,
            ),
        }
    } else {
        (Vec::new(), None, false)
    }
}

#[cfg(test)]
fn is_http_401_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("(401)") || message.contains("unauthorized")
}

fn make_entry(
    label: Option<String>,
    tokens_result: Option<&Result<Tokens, String>>,
    index_entry: Option<&ProfileIndexEntry>,
    profile_path: &Path,
    ctx: &ListCtx,
    is_current: bool,
) -> Entry {
    let use_color = ctx.use_color;
    let label_for_error = label.clone().or_else(|| profile_id_from_path(profile_path));
    let mut tokens = match tokens_result {
        Some(Ok(tokens)) => tokens.clone(),
        Some(Err(err)) => {
            return make_error(
                label_for_error,
                index_entry,
                use_color,
                err,
                PROFILE_SUMMARY_ERROR,
                is_current,
            );
        }
        None => {
            return make_error(
                label_for_error,
                index_entry,
                use_color,
                PROFILE_SUMMARY_FILE_MISSING,
                PROFILE_SUMMARY_ERROR,
                is_current,
            );
        }
    };
    let info = profile_info(Some(&tokens), label, is_current, use_color);
    let (details, summary, _) = detail_lines(
        &mut tokens,
        info.email.as_deref(),
        info.plan.as_deref(),
        profile_path,
        ctx,
    );
    Entry {
        display: info.display,
        details,
        error_summary: summary,
        always_show_details: info.is_free,
    }
}

fn make_saved(
    id: &str,
    snapshot: &Snapshot,
    labels_by_id: &BTreeMap<String, String>,
    current_saved_id: Option<&str>,
    ctx: &ListCtx,
) -> Entry {
    let profile_path = ctx.profiles_dir.join(format!("{id}.json"));
    let label = labels_by_id.get(id).cloned();
    let is_current = current_saved_id == Some(id);
    make_entry(
        label,
        snapshot.tokens.get(id),
        snapshot.index.profiles.get(id),
        &profile_path,
        ctx,
        is_current,
    )
}

fn make_entries(
    ordered: &[String],
    snapshot: &Snapshot,
    current_saved_id: Option<&str>,
    ctx: &ListCtx,
) -> Vec<Entry> {
    let labels_by_id = labels_by_id(&snapshot.labels);
    let build = |id: &String| make_saved(id, snapshot, &labels_by_id, current_saved_id, ctx);
    if ctx.show_usage && ordered.len() >= 3 {
        if ordered.len() > MAX_USAGE_CONCURRENCY {
            let mut entries = Vec::with_capacity(ordered.len());
            for chunk in ordered.chunks(MAX_USAGE_CONCURRENCY) {
                let mut chunk_entries: Vec<Entry> = chunk.par_iter().map(build).collect();
                entries.append(&mut chunk_entries);
            }
            return entries;
        }
        return ordered.par_iter().map(build).collect();
    }

    ordered.iter().map(build).collect()
}

fn is_api_saved_profile(id: &str, snapshot: &Snapshot) -> bool {
    if let Some(Ok(tokens)) = snapshot.tokens.get(id)
        && is_api_key_profile(tokens)
    {
        return true;
    }
    snapshot
        .index
        .profiles
        .get(id)
        .map(|entry| entry.is_api_key)
        .unwrap_or(false)
}

fn make_current(
    paths: &Paths,
    current_saved_id: Option<&str>,
    labels: &Labels,
    tokens_map: &BTreeMap<String, Result<Tokens, String>>,
    ctx: &ListCtx,
) -> Option<Entry> {
    if !paths.auth.is_file() {
        return None;
    }
    let mut tokens = match read_tokens(&paths.auth) {
        Ok(tokens) => tokens,
        Err(err) => {
            return Some(make_error(
                None,
                None,
                ctx.use_color,
                &err,
                PROFILE_SUMMARY_ERROR,
                true,
            ));
        }
    };
    let resolved_saved_id = extract_profile_identity(&tokens).and_then(|identity| {
        let candidates = cached_profile_ids(tokens_map, &identity);
        pick_primary(&candidates)
    });
    let effective_saved_id = current_saved_id.or(resolved_saved_id.as_deref());
    let label = effective_saved_id.and_then(|id| label_for_id(labels, id));
    let use_color = ctx.use_color;
    let info = profile_info(Some(&tokens), label, true, use_color);
    let plan_is_free = info.is_free;
    let can_save = is_profile_ready(&tokens);
    let is_unsaved = effective_saved_id.is_none() && can_save;
    let (mut details, summary, refreshed) = detail_lines(
        &mut tokens,
        info.email.as_deref(),
        info.plan.as_deref(),
        &ctx.auth_path,
        ctx,
    );

    if refreshed && let Some(id) = effective_saved_id {
        let profile_path = ctx.profiles_dir.join(format!("{id}.json"));
        if profile_path.is_file()
            && let Err(err) = copy_atomic(&ctx.auth_path, &profile_path)
        {
            let warning = format_warning(&normalize_error(&err), use_color_stderr());
            eprintln!("{warning}");
        }
    }

    if is_unsaved {
        details.extend(format_unsaved_warning(use_color));
    }

    Some(Entry {
        display: info.display,
        details,
        error_summary: summary,
        always_show_details: is_unsaved || (plan_is_free && !ctx.show_usage),
    })
}

fn error_summary(label: &str, message: &str) -> String {
    format!("{label}: {}", normalize_error(message))
}

struct ListCtx {
    base_url: Option<String>,
    now: DateTime<Local>,
    show_usage: bool,
    use_color: bool,
    profiles_dir: PathBuf,
    auth_path: PathBuf,
}

impl ListCtx {
    fn new(paths: &Paths, show_usage: bool) -> Self {
        Self {
            base_url: show_usage.then(|| read_base_url(paths)),
            now: Local::now(),
            show_usage,
            use_color: use_color_stdout(),
            profiles_dir: paths.profiles.clone(),
            auth_path: paths.auth.clone(),
        }
    }
}

struct Entry {
    display: String,
    details: Vec<String>,
    error_summary: Option<String>,
    always_show_details: bool,
}

fn handle_inquire_result<T>(
    result: Result<T, inquire::error::InquireError>,
    context: &str,
) -> Result<T, String> {
    match result {
        Ok(value) => Ok(value),
        Err(err) if is_inquire_cancel(&err) => Err(CANCELLED_MESSAGE.to_string()),
        Err(err) => Err(crate::msg2(PROFILE_ERR_PROMPT_CONTEXT, context, err)),
    }
}

fn trim_label(label: &str) -> Result<&str, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err(PROFILE_ERR_LABEL_EMPTY.to_string());
    }
    Ok(trimmed)
}

fn is_profile_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    if ext != "json" {
        return false;
    }
    !matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some("profiles.json" | "update.json")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{build_id_token, make_paths};
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn write_auth(
        path: &Path,
        account_id: &str,
        email: &str,
        plan: &str,
        access: &str,
        refresh: &str,
    ) {
        let id_token = build_id_token(email, plan);
        let value = serde_json::json!({
            "tokens": {
                "account_id": account_id,
                "id_token": id_token,
                "access_token": access,
                "refresh_token": refresh
            }
        });
        fs::write(path, serde_json::to_string(&value).unwrap()).unwrap();
    }

    fn write_profile(paths: &Paths, id: &str, account_id: &str, email: &str, plan: &str) {
        let id_token = build_id_token(email, plan);
        let value = serde_json::json!({
            "tokens": {
                "account_id": account_id,
                "id_token": id_token,
                "access_token": "acc",
                "refresh_token": "ref"
            }
        });
        let path = profile_path_for_id(&paths.profiles, id);
        fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();
    }

    fn build_id_token_with_user(email: &str, plan: &str, user_id: &str) -> String {
        let header = serde_json::json!({
            "alg": "none",
            "typ": "JWT",
        });
        let auth = serde_json::json!({
            "chatgpt_plan_type": plan,
            "chatgpt_user_id": user_id,
        });
        let payload = serde_json::json!({
            "email": email,
            "https://api.openai.com/auth": auth,
        });
        let header = URL_SAFE_NO_PAD.encode(serde_json::to_string(&header).unwrap());
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_string(&payload).unwrap());
        format!("{header}.{payload}.")
    }

    fn write_auth_with_user(
        path: &Path,
        account_id: &str,
        email: &str,
        plan: &str,
        user_id: &str,
        access: &str,
        refresh: &str,
    ) {
        let id_token = build_id_token_with_user(email, plan, user_id);
        let value = serde_json::json!({
            "tokens": {
                "account_id": account_id,
                "id_token": id_token,
                "access_token": access,
                "refresh_token": refresh
            }
        });
        fs::write(path, serde_json::to_string(&value).unwrap()).unwrap();
    }

    fn make_identity(principal: &str, workspace: &str, plan: &str) -> ProfileIdentityKey {
        ProfileIdentityKey {
            principal_id: principal.to_string(),
            workspace_or_org_id: workspace.to_string(),
            plan_type: plan.to_string(),
        }
    }

    #[test]
    fn require_tty_with_variants() {
        assert!(require_tty_with(true, "load").is_ok());
        let err = require_tty_with(false, "load").unwrap_err();
        assert!(err.contains("requires a TTY"));
    }

    #[test]
    fn prompt_unsaved_load_with_variants() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        let err = prompt_unsaved_load_with(&paths, "reason", false, Ok(PROFILE_PROMPT_CANCEL))
            .unwrap_err();
        assert!(err.contains("not saved"));
        assert!(matches!(
            prompt_unsaved_load_with(&paths, "reason", true, Ok(PROFILE_PROMPT_SAVE_AND_CONTINUE))
                .unwrap(),
            LoadChoice::SaveAndContinue
        ));
        assert!(matches!(
            prompt_unsaved_load_with(
                &paths,
                "reason",
                true,
                Ok(PROFILE_PROMPT_CONTINUE_WITHOUT_SAVING)
            )
            .unwrap(),
            LoadChoice::ContinueWithoutSaving
        ));
        assert!(matches!(
            prompt_unsaved_load_with(&paths, "reason", true, Ok(PROFILE_PROMPT_CANCEL)).unwrap(),
            LoadChoice::Cancel
        ));
        let err = prompt_unsaved_load_with(
            &paths,
            "reason",
            true,
            Err(inquire::error::InquireError::OperationCanceled),
        )
        .unwrap();
        assert!(matches!(err, LoadChoice::Cancel));
    }

    #[test]
    fn confirm_delete_profiles_with_variants() {
        let err = confirm_delete_profiles_with(false, Ok(true)).unwrap_err();
        assert!(err.contains("requires confirmation"));
        assert!(confirm_delete_profiles_with(true, Ok(true)).unwrap());
        let err = confirm_delete_profiles_with(
            true,
            Err(inquire::error::InquireError::OperationCanceled),
        )
        .unwrap_err();
        assert_eq!(err, CANCELLED_MESSAGE);
    }

    #[test]
    fn label_helpers() {
        let mut labels = Labels::new();
        assign_label(&mut labels, "Team", "id").unwrap();
        assert_eq!(label_for_id(&labels, "id").unwrap(), "Team");
        assert_eq!(resolve_label_id(&labels, "Team").unwrap(), "id");
        remove_labels_for_id(&mut labels, "id");
        assert!(labels.is_empty());
        assert!(trim_label(" ").is_err());
    }

    #[test]
    fn profiles_index_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        let mut index = ProfilesIndex::default();
        index.profiles.insert(
            "id".to_string(),
            ProfileIndexEntry {
                account_id: Some("acct".to_string()),
                email: Some("me@example.com".to_string()),
                plan: Some("Team".to_string()),
                label: Some("work".to_string()),
                is_api_key: false,
                principal_id: Some("principal-1".to_string()),
                workspace_or_org_id: Some("workspace-1".to_string()),
                plan_type_key: Some("team".to_string()),
            },
        );
        write_profiles_index(&paths, &index).unwrap();
        let read_back = read_profiles_index(&paths).unwrap();
        let entry = read_back.profiles.get("id").unwrap();
        assert_eq!(entry.account_id.as_deref(), Some("acct"));
        assert_eq!(entry.email.as_deref(), Some("me@example.com"));
        assert_eq!(entry.plan.as_deref(), Some("Team"));
        assert_eq!(entry.label.as_deref(), Some("work"));
        assert!(!entry.is_api_key);
        assert_eq!(entry.principal_id.as_deref(), Some("principal-1"));
        assert_eq!(entry.workspace_or_org_id.as_deref(), Some("workspace-1"));
        assert_eq!(entry.plan_type_key.as_deref(), Some("team"));
    }

    #[test]
    fn profiles_index_prunes_missing_profiles() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        let mut index = ProfilesIndex::default();
        index
            .profiles
            .insert("missing".to_string(), ProfileIndexEntry::default());
        prune_profiles_index(&mut index, &paths.profiles).unwrap();
        assert!(index.profiles.is_empty());
    }

    #[test]
    fn sanitize_helpers() {
        assert_eq!(sanitize_part("A B"), "a-b");
        assert_eq!(profile_base("", ""), "unknown-unknown");
        let identity = make_identity("principal", "workspace123", "team");
        assert_eq!(short_identity_suffix(&identity), "worksp");
        let unknown_workspace = make_identity("principal123", "unknown", "team");
        assert_eq!(short_identity_suffix(&unknown_workspace), "princi");
    }

    #[test]
    fn unique_id_conflicts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        write_profile(&paths, "base", "acct", "a@b.com", "pro");
        let id = unique_id(
            "base",
            &make_identity("acct", "acct", "pro"),
            &paths.profiles,
        );
        assert_eq!(id, "base");
        let id = unique_id(
            "base",
            &make_identity("other", "other", "pro"),
            &paths.profiles,
        );
        assert!(id.starts_with("base-"));
    }

    #[test]
    fn load_profile_tokens_map_handles_invalid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        write_profile(&paths, "valid", "acct", "a@b.com", "pro");
        fs::write(paths.profiles.join("bad.json"), "not-json").unwrap();
        let index = serde_json::json!({
            "version": 1,
            "active_profile_id": null,
            "profiles": {
                "bad": {
                    "label": "bad",
                    "last_used": 1,
                    "added_at": 1
                }
            }
        });
        fs::write(
            &paths.profiles_index,
            serde_json::to_string(&index).unwrap(),
        )
        .unwrap();
        let map = load_profile_tokens_map(&paths).unwrap();
        assert!(map.contains_key("valid"));
    }

    #[test]
    fn load_profile_tokens_map_ignores_update_cache_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        fs::write(
            &paths.update_cache,
            serde_json::json!({
                "latest_version": "0.1.0",
                "last_checked_at": "2026-01-01T00:00:00Z"
            })
            .to_string(),
        )
        .unwrap();
        let map = load_profile_tokens_map(&paths).unwrap();
        assert!(map.is_empty());
        assert!(paths.update_cache.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn load_profile_tokens_map_remove_error() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        let bad_path = paths.profiles.join("bad.json");
        fs::write(&bad_path, "not-json").unwrap();
        let perms = fs::Permissions::from_mode(0o400);
        fs::set_permissions(&paths.profiles, perms).unwrap();
        let map = load_profile_tokens_map(&paths).unwrap();
        assert!(map.contains_key("bad"));
    }

    #[test]
    fn resolve_save_and_sync_ids() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        write_profile(&paths, "one", "acct", "a@b.com", "pro");
        let tokens = read_tokens(&paths.profiles.join("one.json")).unwrap();
        let mut index = ProfilesIndex::default();
        let id = resolve_save_id(&paths, &mut index, &tokens).unwrap();
        assert!(!id.is_empty());
        let id = resolve_sync_id(&paths, &mut index, &tokens).unwrap();
        assert!(id.is_some());
    }

    #[test]
    fn rename_profile_id_errors_when_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        let mut index = ProfilesIndex::default();
        let err = rename_profile_id(
            &paths,
            &mut index,
            "missing",
            "base",
            &make_identity("acct", "acct", "pro"),
        )
        .unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn render_helpers() {
        let entry = Entry {
            display: "Display".to_string(),
            details: vec!["detail".to_string()],
            error_summary: None,
            always_show_details: true,
        };
        let ctx = ListCtx {
            base_url: None,
            now: chrono::Local::now(),
            show_usage: false,
            use_color: false,
            profiles_dir: PathBuf::new(),
            auth_path: PathBuf::new(),
        };
        let lines = render_entries(&[entry], &ctx, true);
        assert!(!lines.is_empty());
        push_separator(&mut vec!["a".to_string()], true);
    }

    #[test]
    fn handle_inquire_result_variants() {
        let ok: Result<i32, inquire::error::InquireError> = Ok(1);
        assert_eq!(handle_inquire_result(ok, "selection").unwrap(), 1);
        let err: Result<(), inquire::error::InquireError> =
            Err(inquire::error::InquireError::OperationCanceled);
        let err = handle_inquire_result(err, "selection").unwrap_err();
        assert_eq!(err, CANCELLED_MESSAGE);
    }

    #[test]
    fn is_http_401_message_variants() {
        assert!(is_http_401_message(&crate::msg2(
            crate::UI_ERROR_TWO_LINE,
            crate::AUTH_REFRESH_401_TITLE,
            crate::AUTH_RELOGIN_AND_SAVE
        )));
        assert!(is_http_401_message("Error: Unauthorized (401)"));
        assert!(!is_http_401_message(&crate::msg1(
            "Error: {}",
            crate::USAGE_UNAVAILABLE_402_TITLE
        )));
    }

    #[test]
    fn sync_and_status_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        write_auth(&paths.auth, "acct", "a@b.com", "pro", "acc", "ref");
        crate::ensure_paths(&paths).unwrap();
        save_profile(&paths, Some("team".to_string())).unwrap();
        list_profiles(&paths).unwrap();
        status_profiles(&paths, false, false).unwrap();
        status_profiles(&paths, true, false).unwrap();
    }

    #[test]
    fn delete_profile_by_label() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        write_auth(&paths.auth, "acct", "a@b.com", "pro", "acc", "ref");
        crate::ensure_paths(&paths).unwrap();
        save_profile(&paths, Some("team".to_string())).unwrap();
        delete_profile(&paths, true, Some("team".to_string())).unwrap();
    }

    #[test]
    fn composite_identity_repeated_save_dedupes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        write_auth_with_user(
            &paths.auth,
            "acct-1",
            "same@example.com",
            "pro",
            "user-1",
            "acc",
            "ref",
        );
        crate::ensure_paths(&paths).unwrap();

        save_profile(&paths, None).unwrap();
        save_profile(&paths, None).unwrap();

        let ids = collect_profile_ids(&paths.profiles).unwrap();
        assert_eq!(ids.len(), 1);
        assert!(ids.contains("same@example.com-pro"));
    }

    #[test]
    fn composite_identity_keeps_team_and_pro_separate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        crate::ensure_paths(&paths).unwrap();

        write_auth_with_user(
            &paths.auth,
            "acct-1",
            "same@example.com",
            "pro",
            "user-1",
            "acc",
            "ref",
        );
        save_profile(&paths, None).unwrap();

        write_auth_with_user(
            &paths.auth,
            "acct-1",
            "same@example.com",
            "team",
            "user-1",
            "acc",
            "ref",
        );
        save_profile(&paths, None).unwrap();

        let ids = collect_profile_ids(&paths.profiles).unwrap();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("same@example.com-pro"));
        assert!(ids.contains("same@example.com-team"));
    }

    #[test]
    fn composite_identity_separates_users_in_same_workspace_plan() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        crate::ensure_paths(&paths).unwrap();

        write_auth_with_user(
            &paths.auth,
            "acct-1",
            "same@example.com",
            "pro",
            "user-1",
            "acc",
            "ref",
        );
        save_profile(&paths, None).unwrap();

        write_auth_with_user(
            &paths.auth,
            "acct-1",
            "same@example.com",
            "pro",
            "user-2",
            "acc",
            "ref",
        );
        save_profile(&paths, None).unwrap();

        let ids = collect_profile_ids(&paths.profiles).unwrap();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("same@example.com-pro"));
        assert!(
            ids.iter()
                .any(|id| id.starts_with("same@example.com-pro-acct"))
        );
    }
}
