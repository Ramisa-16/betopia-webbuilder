pub mod background;
pub use background::*;

use serde::Serialize;
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

#[derive(Serialize)]
pub struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

const SHELL_TIMEOUT_SECS: u64 = 30;
const SHELL_TIMEOUT_MAX_SECS: u64 = 600; // hard cap — prevents runaway long-polls
// Cap output to avoid flooding the frontend with megabytes of install logs.
const OUTPUT_CAP: usize = 150_000;

/// One-shot shell execution for AI tools.
/// Async with a 30-second timeout: long-running servers (npm run dev, etc.) are
/// killed after the timeout and a hint is returned so the agent uses the Terminal tab instead.
/// On Windows: uses cmd.exe so npm/python/pip work without WSL.
/// On Unix: uses /bin/bash or /bin/sh.
#[tauri::command]
pub async fn shell_run_command(command: String, cwd: Option<String>, timeout_secs: Option<u64>) -> Result<ShellOutput, String> {
    let effective_timeout = timeout_secs
        .unwrap_or(SHELL_TIMEOUT_SECS)
        .min(SHELL_TIMEOUT_MAX_SECS);
    #[cfg(windows)]
    let (shell, flag): (&str, &str) = ("cmd.exe", "/C");

    #[cfg(not(windows))]
    let (shell, flag): (&str, &str) = (
        if std::path::Path::new("/bin/bash").exists() { "/bin/bash" } else { "/bin/sh" },
        "-c",
    );

    let mut cmd = Command::new(shell);
    cmd.arg(flag)
        .arg(&command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }

    // Prevent a visible CMD window from flashing on Windows
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdout_pipe = child.stdout.take().expect("stdout piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr piped");

    let run = async move {
        // Read stdout and stderr concurrently — prevents pipe-buffer deadlock when one
        // pipe fills up while we're blocked reading the other.
        let (mut out_buf, mut err_buf) = (Vec::new(), Vec::new());
        tokio::try_join!(
            stdout_pipe.read_to_end(&mut out_buf),
            stderr_pipe.read_to_end(&mut err_buf),
        )?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((out_buf, err_buf, status.code().unwrap_or(-1)))
    };

    match timeout(Duration::from_secs(effective_timeout), run).await {
        Ok(Ok((out, err, code))) => Ok(ShellOutput {
            stdout: cap_output(out),
            stderr: cap_output(err),
            exit_code: code,
        }),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_timed_out) => Ok(ShellOutput {
            stdout: String::new(),
            stderr: format!(
                "[Command timed out after {}s. For long-running servers use run_in_background:true. For slow builds pass a larger timeout (e.g. timeout:120).]",
                effective_timeout
            ),
            exit_code: -1,
        }),
    }
}

fn cap_output(bytes: Vec<u8>) -> String {
    let s = String::from_utf8_lossy(&bytes).into_owned();
    if s.len() > OUTPUT_CAP {
        format!("{}…\n[output truncated — {} bytes total]", &s[..OUTPUT_CAP], s.len())
    } else {
        s
    }
}
