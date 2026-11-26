use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PatchProgress {
    pub stage: String, // "downloading" | "patching" | "relaunching" | "error"
    pub downloaded: u64,
    pub total: u64,
    pub percent: f32,
    pub message: String,
}

/// Automatically removes any left-over `.exe.old` from previous auto-patching sessions.
pub fn cleanup_old_executables() {
    if let Ok(current_exe) = std::env::current_exe() {
        let old_exe = current_exe.with_extension("exe.old");
        if old_exe.exists() {
            let _ = fs::remove_file(old_exe);
        }
    }
}

/// Downloads the specified portable .exe from `download_url`, atomically replaces the current running
/// executable, and relaunches the application without requiring the user to reinstall anything manually.
#[tauri::command]
pub async fn auto_patch_portable_exe(
    app: AppHandle,
    download_url: String,
) -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Failed to locate current executable path: {}", e))?;

    let exe_dir = current_exe
        .parent()
        .ok_or_else(|| "Failed to determine executable directory".to_string())?;

    let file_stem = current_exe
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let temp_new_exe = exe_dir.join(format!(".{}.new", file_stem));

    let _ = app.emit(
        "auto-patch:progress",
        PatchProgress {
            stage: "downloading".to_string(),
            downloaded: 0,
            total: 0,
            percent: 0.0,
            message: "Connecting to update server...".to_string(),
        },
    );

    // Build HTTP client (reqwest follows redirects to GitHub release assets automatically)
    let client = reqwest::Client::builder()
        .user_agent("JustAnotherMusicClient-AutoPatcher/1.3.2")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Download connection failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Update server returned HTTP status {}",
            response.status()
        ));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut file = File::create(&temp_new_exe)
        .map_err(|e| format!("Failed to create temporary patch file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to download patch chunk: {}", e))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write patch data: {}", e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= std::time::Duration::from_millis(150) || downloaded == total_size {
            let percent = if total_size > 0 {
                ((downloaded as f64 / total_size as f64) * 100.0) as f32
            } else {
                0.0
            };
            let _ = app.emit(
                "auto-patch:progress",
                PatchProgress {
                    stage: "downloading".to_string(),
                    downloaded,
                    total: total_size,
                    percent,
                    message: format!(
                        "Downloading update: {:.1} MB / {:.1} MB ({:.0}%)",
                        downloaded as f64 / 1_048_576.0,
                        total_size as f64 / 1_048_576.0,
                        percent
                    ),
                },
            );
            last_emit = std::time::Instant::now();
        }
    }

    file.flush()
        .map_err(|e| format!("Failed to flush patch file: {}", e))?;
    drop(file);

    // Sanity check: a valid JustAnotherMusicClient executable must be at least 5 MB
    let meta = fs::metadata(&temp_new_exe)
        .map_err(|e| format!("Failed to verify downloaded patch file: {}", e))?;
    if meta.len() < 5_000_000 {
        let _ = fs::remove_file(&temp_new_exe);
        return Err(format!(
            "Downloaded update file is too small ({:.1} KB). Patch aborted.",
            meta.len() as f64 / 1024.0
        ));
    }

    let _ = app.emit(
        "auto-patch:progress",
        PatchProgress {
            stage: "patching".to_string(),
            downloaded,
            total: total_size,
            percent: 100.0,
            message: "Applying patch and restarting...".to_string(),
        },
    );

    apply_patch_and_relaunch(&current_exe, &temp_new_exe, &app)
}

fn apply_patch_and_relaunch(
    current_exe: &Path,
    temp_new_exe: &Path,
    app: &AppHandle,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let old_exe = current_exe.with_extension("exe.old");
        if old_exe.exists() {
            let _ = fs::remove_file(&old_exe);
        }

        // On Windows NTFS, a running executable CAN be renamed to .old.
        // Once renamed, the new executable can take its original filename.
        let direct_rename_ok = fs::rename(current_exe, &old_exe).is_ok()
            && fs::rename(temp_new_exe, current_exe).is_ok();

        if direct_rename_ok {
            let _ = app.emit(
                "auto-patch:progress",
                PatchProgress {
                    stage: "relaunching".to_string(),
                    downloaded: 0,
                    total: 0,
                    percent: 100.0,
                    message: "Relaunching updated client...".to_string(),
                },
            );

            std::thread::sleep(std::time::Duration::from_millis(200));
            let _ = std::process::Command::new(current_exe).spawn();
            std::process::exit(0);
        }

        // Fallback: spawn a detached PowerShell script that waits for current PID to exit,
        // moves the new executable into place, and launches it.
        let pid = std::process::id();
        let script = format!(
            "$targetPid = {pid}; \
             $temp = '{temp}'; \
             $target = '{target}'; \
             Start-Sleep -Milliseconds 500; \
             while (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 150 }}; \
             Move-Item -Force -LiteralPath $temp -Destination $target; \
             Start-Process -FilePath $target",
            pid = pid,
            temp = temp_new_exe.to_string_lossy().replace('\'', "''"),
            target = current_exe.to_string_lossy().replace('\'', "''")
        );

        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to spawn background updater script: {}", e))?;

        std::process::exit(0);
    }

    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(temp_new_exe, current_exe)
            .map_err(|e| format!("Failed to replace binary: {}", e))?;
        let _ = std::process::Command::new(current_exe).spawn();
        std::process::exit(0);
    }
}
