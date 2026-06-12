use clap::{Parser, Subcommand};

/// mesa — local-first project management for humans and agents.
#[derive(Parser)]
#[command(name = "mesa", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Manage projects
    Project,
    /// Manage tasks
    Task,
    /// Start the HTTP server and web UI
    Serve,
    /// Snapshot the database to a file
    Backup,
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::Project => eprintln!("not yet implemented: project"),
        Command::Task => eprintln!("not yet implemented: task"),
        Command::Serve => eprintln!("not yet implemented: serve"),
        Command::Backup => eprintln!("not yet implemented: backup"),
    }
}
