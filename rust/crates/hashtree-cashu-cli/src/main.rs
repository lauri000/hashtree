use anyhow::Result;
use clap::{Parser, Subcommand};
use hashtree_cli::cashu_cli::{
    add_mint, list_mints, print_balance, remove_mint, set_default_mint, topup_balance,
};
use hashtree_cli::config::get_hashtree_dir;
use hashtree_cli::Config;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "htree-cashu")]
#[command(version)]
#[command(about = "Cashu wallet helper for hashtree", long_about = None)]
struct Cli {
    /// Data directory (default: ~/.hashtree/data)
    #[arg(long, global = true, env = "HTREE_DATA_DIR")]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

impl Cli {
    fn data_dir(&self) -> PathBuf {
        self.data_dir
            .clone()
            .unwrap_or_else(|| get_hashtree_dir().join("data"))
    }
}

#[derive(Subcommand)]
enum Commands {
    /// Show Cashu wallet balances
    #[command(visible_alias = "status")]
    Balance {
        /// Show only one mint
        #[arg(long)]
        mint: Option<String>,
    },
    /// Create a Cashu top-up quote from the selected mint
    #[command(visible_alias = "load")]
    Topup {
        /// Amount in satoshis
        amount_sat: u64,
        /// Mint to use (defaults to configured default mint)
        #[arg(long)]
        mint: Option<String>,
    },
    /// Manage accepted Cashu mints
    Mint {
        #[command(subcommand)]
        command: MintCommands,
    },
}

#[derive(Subcommand)]
enum MintCommands {
    /// List accepted mints
    List,
    /// Add an accepted mint
    Add {
        /// Mint base URL
        url: String,
        /// Also set as default mint
        #[arg(long = "default")]
        make_default: bool,
    },
    /// Remove an accepted mint
    Remove {
        /// Mint base URL
        url: String,
    },
    /// Set the default mint
    Default {
        /// Mint base URL
        url: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cli = Cli::parse();
    let data_dir = cli.data_dir();
    let mut config = Config::load()?;

    match cli.command {
        Commands::Balance { mint } => {
            print_balance(&config, &data_dir, mint.as_deref()).await?;
        }
        Commands::Topup { amount_sat, mint } => {
            topup_balance(&config, &data_dir, amount_sat, mint.as_deref()).await?;
        }
        Commands::Mint { command } => match command {
            MintCommands::List => {
                list_mints(&config);
            }
            MintCommands::Add { url, make_default } => {
                add_mint(&mut config, &url, make_default)?;
            }
            MintCommands::Remove { url } => {
                remove_mint(&mut config, &url)?;
            }
            MintCommands::Default { url } => {
                set_default_mint(&mut config, &url)?;
            }
        },
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_parses_topup_alias_and_mint_add() {
        let cli = Cli::parse_from([
            "htree-cashu",
            "load",
            "21",
            "--mint",
            "https://mint.example",
        ]);
        match cli.command {
            Commands::Topup { amount_sat, mint } => {
                assert_eq!(amount_sat, 21);
                assert_eq!(mint.as_deref(), Some("https://mint.example"));
            }
            _ => panic!("expected topup command"),
        }

        let cli = Cli::parse_from([
            "htree-cashu",
            "mint",
            "add",
            "https://mint.example",
            "--default",
        ]);
        match cli.command {
            Commands::Mint {
                command: MintCommands::Add { url, make_default },
            } => {
                assert_eq!(url, "https://mint.example");
                assert!(make_default);
            }
            _ => panic!("expected mint add command"),
        }
    }
}
