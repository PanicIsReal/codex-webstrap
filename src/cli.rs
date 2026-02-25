use clap::{Command, CommandFactory, Parser, Subcommand};

use crate::command_name;

#[derive(Parser)]
#[command(author, version, about, color = clap::ColorChoice::Never)]
pub struct Cli {
    /// Disable styling and separators
    #[arg(long, global = true)]
    pub plain: bool,
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Save the current auth.json as a profile
    Save {
        /// Optional label for the profile (must be unique)
        #[arg(value_name = "label")]
        #[arg(long)]
        label: Option<String>,
    },
    /// Load a profile from the interactive list
    Load {
        /// Load the profile matching this label
        #[arg(value_name = "label")]
        #[arg(long)]
        label: Option<String>,
    },
    /// List saved profiles
    List,
    /// Show usage details for the current profile
    Status {
        /// Show usage for all saved profiles
        #[arg(long)]
        all: bool,
        /// Include errored profiles in --all output
        #[arg(long, requires = "all")]
        show_errors: bool,
    },
    /// Delete saved profiles from the interactive list
    Delete {
        /// Skip delete confirmation
        #[arg(long)]
        yes: bool,
        /// Delete the profile matching this label
        #[arg(value_name = "label")]
        #[arg(long)]
        label: Option<String>,
    },
}

pub fn command_with_examples() -> Command {
    let name = command_name();
    let mut cmd = Cli::command();
    cmd.set_bin_name(name);
    cmd = cmd.after_help(examples_root(name));
    cmd
}

fn examples_root(name: &str) -> String {
    format!(
        "Examples:\n  {name} save --label work\n  {name} load --label work\n  {name} list\n  {name} status\n  {name} delete --label work"
    )
}
