use clap::{FromArgMatches, error::ErrorKind};
use std::process::Command as ProcessCommand;

use crate::cli::{Cli, Commands, command_with_examples};

pub fn run_cli() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if let Err(message) = run_cli_with_args(args) {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn run_cli_with_args(args: Vec<std::ffi::OsString>) -> Result<(), String> {
    if args.len() == 1 {
        let name = package_command_name();
        println!("{name} {}", env!("CARGO_PKG_VERSION"));
        println!();
        let mut cmd = command_with_examples();
        let _ = cmd.print_help();
        println!();
        return Ok(());
    }
    let cmd = command_with_examples();
    let matches = match cmd.clone().try_get_matches_from(args) {
        Ok(matches) => matches,
        Err(err) => {
            if err.kind() == ErrorKind::DisplayHelp {
                let name = package_command_name();
                println!("{name} {}", env!("CARGO_PKG_VERSION"));
                println!();
                let _ = err.print();
                println!();
                return Ok(());
            }
            return Err(err.to_string());
        }
    };
    let cli = Cli::from_arg_matches(&matches).map_err(|err| err.to_string())?;
    set_plain(cli.plain);
    if let Err(message) = run(cli) {
        if message == CANCELLED_MESSAGE {
            let message = format_cancel(use_color_stdout());
            print_output_block(&message);
            return Ok(());
        }
        return Err(message);
    }
    Ok(())
}

fn run(cli: Cli) -> Result<(), String> {
    let paths = resolve_paths()?;
    ensure_paths(&paths)?;

    let check_for_update_on_startup = std::env::var_os("CODEX_PROFILES_SKIP_UPDATE").is_none();
    let update_config = UpdateConfig {
        codex_home: paths.codex.clone(),
        check_for_update_on_startup,
    };
    match run_update_prompt_if_needed(&update_config)? {
        UpdatePromptOutcome::Continue => {}
        UpdatePromptOutcome::RunUpdate(action) => {
            return run_update_action(action);
        }
    }

    match cli.command {
        Commands::Save { label } => save_profile(&paths, label),
        Commands::Load { label } => load_profile(&paths, label),
        Commands::List => list_profiles(&paths),
        Commands::Status { all, show_errors } => status_profiles(&paths, all, show_errors),
        Commands::Delete { yes, label } => delete_profile(&paths, yes, label),
    }
}

fn run_update_action(action: UpdateAction) -> Result<(), String> {
    let (command, args) = action.command_args();
    let status = ProcessCommand::new(command)
        .args(args)
        .status()
        .map_err(|err| crate::msg1(crate::CMD_ERR_UPDATE_RUN, err))?;
    if status.success() {
        Ok(())
    } else {
        Err(crate::msg1(
            crate::CMD_ERR_UPDATE_FAILED,
            action.command_str(),
        ))
    }
}
mod auth;
mod cli;
mod common;
mod messages;
mod profiles;
#[cfg(test)]
mod test_utils;
mod ui;
mod updates;
mod usage;

pub(crate) use auth::*;
pub(crate) use common::*;
pub(crate) use messages::*;
pub(crate) use profiles::*;
pub(crate) use ui::*;
pub(crate) use updates::*;
pub(crate) use usage::*;

pub use auth::{AuthFile, Tokens, extract_email_and_plan};
pub use updates::{
    InstallSource, detect_install_source_inner, extract_version_from_cask,
    extract_version_from_latest_tag, is_newer,
};
pub use usage::parse_config_value;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{make_paths, set_env_guard};
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn run_cli_with_args_help() {
        let args = vec![OsString::from("codex-profiles")];
        run_cli_with_args(args).unwrap();
    }

    #[test]
    fn run_cli_with_args_display_help() {
        let args = vec![OsString::from("codex-profiles"), OsString::from("--help")];
        run_cli_with_args(args).unwrap();
    }

    #[test]
    fn run_cli_with_args_errors() {
        let args = vec![OsString::from("codex-profiles"), OsString::from("nope")];
        let err = run_cli_with_args(args).unwrap_err();
        assert!(err.contains("error"));
    }

    #[test]
    fn run_update_action_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("npm");
        fs::write(&bin, "#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = fs::metadata(&bin).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&bin, perms).unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        {
            let _env = set_env_guard("PATH", Some(&path));
            run_update_action(UpdateAction::NpmGlobalLatest).unwrap();
        }
        {
            let _env = set_env_guard("PATH", Some(""));
            let err = run_update_action(UpdateAction::NpmGlobalLatest).unwrap_err();
            assert!(err.contains("Could not run update command"));
        }
    }

    #[test]
    fn run_cli_list_command() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let _home = set_env_guard("CODEX_PROFILES_HOME", Some(&home));
        let _skip = set_env_guard("CODEX_PROFILES_SKIP_UPDATE", Some("1"));
        let cli = Cli {
            plain: true,
            command: Commands::List,
        };
        run(cli).unwrap();
    }
}
