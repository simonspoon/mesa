//! `mesa`, the pre-rename name of the `naru` binary (mesa task 1301): the
//! same program, kept so every script and agent that runs `mesa` still works.

use std::process::ExitCode;

fn main() -> ExitCode {
    mesa::cli::run()
}
