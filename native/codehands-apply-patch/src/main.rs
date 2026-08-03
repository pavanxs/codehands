use codex_apply_patch::{
    AppliedPatchDelta, AppliedPatchFileChange, ApplyPatchAction, ApplyPatchFileChange, Hunk,
    MaybeApplyPatchVerified, parse_patch, verify_apply_patch_args,
};
use codex_exec_server::LOCAL_FS;
use codex_utils_path_uri::PathUri;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Component, Path, PathBuf};

const MAX_PATCH_BYTES: usize = 200_000;

fn default_version() -> u32 {
    1
}
fn default_true() -> bool {
    true
}
fn default_max_files() -> usize {
    50
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    #[serde(default = "default_version")]
    version: u32,
    patch: String,
    cwd: String,
    workspace_roots: Vec<String>,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    allow_overwrite: bool,
    #[serde(default = "default_true")]
    preserve_line_endings: bool,
    #[serde(default = "default_max_files")]
    max_files: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    operation: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    move_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    overwritten: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    success: bool,
    dry_run: bool,
    partial_applied: bool,
    delta_exact: bool,
    changes: Vec<Change>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Debug)]
struct HelperError {
    code: &'static str,
    message: String,
}

impl HelperError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn failure_response(dry_run: bool, error: HelperError) -> Response {
    Response {
        success: false,
        dry_run,
        partial_applied: false,
        delta_exact: true,
        changes: Vec::new(),
        error: Some(ErrorBody {
            code: error.code.to_string(),
            message: error.message,
        }),
    }
}

fn path_string(uri: &PathUri) -> String {
    uri.inferred_native_path_string()
}

fn has_forbidden_components(path: &Path) -> bool {
    path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn validate_hunk_paths(hunks: &[Hunk]) -> Result<(), HelperError> {
    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, .. } | Hunk::DeleteFile { path } => {
                if has_forbidden_components(path) {
                    return Err(HelperError::new(
                        "PATCH_PATH_INVALID",
                        format!(
                            "Patch paths must be workspace-relative and cannot contain '..': {}",
                            path.display()
                        ),
                    ));
                }
            }
            Hunk::UpdateFile {
                path, move_path, ..
            } => {
                if has_forbidden_components(path) {
                    return Err(HelperError::new(
                        "PATCH_PATH_INVALID",
                        format!(
                            "Patch paths must be workspace-relative and cannot contain '..': {}",
                            path.display()
                        ),
                    ));
                }
                if let Some(destination) = move_path
                    && has_forbidden_components(destination)
                {
                    return Err(HelperError::new(
                        "PATCH_PATH_INVALID",
                        format!(
                            "Move destinations must be workspace-relative and cannot contain '..': {}",
                            destination.display()
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn canonicalize_nearest(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut existing = absolute.clone();
    let mut missing: Vec<OsString> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            break;
        };
        missing.push(name.to_os_string());
        if !existing.pop() {
            break;
        }
    }
    let mut canonical = if existing.exists() {
        fs::canonicalize(existing)?
    } else {
        existing
    };
    for part in missing.into_iter().rev() {
        canonical.push(part);
    }
    Ok(canonical)
}

fn path_within(candidate: &Path, root: &Path) -> bool {
    if candidate.starts_with(root) {
        return true;
    }
    #[cfg(windows)]
    {
        let candidate = candidate.to_string_lossy().replace('/', "\\").to_lowercase();
        let mut root = root.to_string_lossy().replace('/', "\\").to_lowercase();
        while root.ends_with('\\') {
            root.pop();
        }
        candidate == root || candidate.starts_with(&format!("{root}\\"))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn ensure_confined(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, HelperError> {
    let canonical = canonicalize_nearest(path).map_err(|error| {
        HelperError::new(
            "PATCH_PATH_RESOLUTION_FAILED",
            format!("Failed to resolve {}: {error}", path.display()),
        )
    })?;
    if roots.iter().any(|root| path_within(&canonical, root)) {
        Ok(canonical)
    } else {
        Err(HelperError::new(
            "PATCH_PATH_OUTSIDE_WORKSPACE",
            format!("Patch path is outside all approved workspaces: {}", canonical.display()),
        ))
    }
}

fn action_paths(action: &ApplyPatchAction) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for (path, change) in action.changes() {
        paths.push(PathBuf::from(path_string(path)));
        if let ApplyPatchFileChange::Update {
            move_path: Some(destination),
            ..
        } = change
        {
            paths.push(PathBuf::from(path_string(destination)));
        }
    }
    paths
}

fn action_changes(action: &ApplyPatchAction) -> Vec<Change> {
    let mut changes = Vec::new();
    for (path, change) in action.changes() {
        let source = path_string(path);
        let item = match change {
            ApplyPatchFileChange::Add { .. } => Change {
                operation: "add".to_string(),
                path: source.clone(),
                move_path: None,
                overwritten: Some(Path::new(&source).exists()),
            },
            ApplyPatchFileChange::Delete { .. } => Change {
                operation: "delete".to_string(),
                path: source,
                move_path: None,
                overwritten: None,
            },
            ApplyPatchFileChange::Update { move_path, .. } => Change {
                operation: if move_path.is_some() {
                    "move".to_string()
                } else {
                    "update".to_string()
                },
                path: source,
                move_path: move_path.as_ref().map(path_string),
                overwritten: move_path
                    .as_ref()
                    .map(|destination| Path::new(&path_string(destination)).exists()),
            },
        };
        changes.push(item);
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    changes
}

fn ensure_overwrite_policy(
    action: &ApplyPatchAction,
    allow_overwrite: bool,
) -> Result<(), HelperError> {
    if allow_overwrite {
        return Ok(());
    }
    for (path, change) in action.changes() {
        match change {
            ApplyPatchFileChange::Add { .. } if Path::new(&path_string(path)).exists() => {
                return Err(HelperError::new(
                    "PATCH_OVERWRITE_REJECTED",
                    format!(
                        "Add File would overwrite an existing path: {}",
                        path_string(path)
                    ),
                ));
            }
            ApplyPatchFileChange::Update {
                move_path: Some(destination),
                ..
            } if Path::new(&path_string(destination)).exists() => {
                return Err(HelperError::new(
                    "PATCH_OVERWRITE_REJECTED",
                    format!(
                        "Move destination already exists: {}",
                        path_string(destination)
                    ),
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn prefers_crlf(content: &str) -> bool {
    let crlf = content.matches("\r\n").count();
    let all_lf = content.bytes().filter(|byte| *byte == b'\n').count();
    let bare_lf = all_lf.saturating_sub(crlf);
    crlf > 0 && crlf >= bare_lf
}

fn line_ending_preferences(action: &ApplyPatchAction) -> HashMap<String, bool> {
    let mut preferences = HashMap::new();
    for (path, change) in action.changes() {
        if matches!(change, ApplyPatchFileChange::Update { .. }) {
            let source = path_string(path);
            if let Ok(content) = fs::read_to_string(&source) {
                preferences.insert(source, prefers_crlf(&content));
            }
        }
    }
    preferences
}

fn crlf_content(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n")
}

fn preserve_committed_line_endings(
    delta: &AppliedPatchDelta,
    preferences: &HashMap<String, bool>,
) -> Result<(), HelperError> {
    for change in delta.changes() {
        let source = path_string(&change.path);
        if !preferences.get(&source).copied().unwrap_or(false) {
            continue;
        }
        if let AppliedPatchFileChange::Update {
            move_path,
            new_content,
            ..
        } = &change.change
        {
            let target = move_path
                .as_ref()
                .map(path_string)
                .unwrap_or_else(|| source.clone());
            fs::write(&target, crlf_content(new_content)).map_err(|error| {
                HelperError::new(
                    "LINE_ENDING_PRESERVATION_FAILED",
                    format!("Failed to preserve CRLF in {target}: {error}"),
                )
            })?;
        }
    }
    Ok(())
}

fn delta_changes(delta: &AppliedPatchDelta) -> Vec<Change> {
    let mut changes = Vec::new();
    for applied in delta.changes() {
        let source = path_string(&applied.path);
        let item = match &applied.change {
            AppliedPatchFileChange::Add {
                overwritten_content,
                ..
            } => Change {
                operation: "add".to_string(),
                path: source,
                move_path: None,
                overwritten: Some(overwritten_content.is_some()),
            },
            AppliedPatchFileChange::Delete { .. } => Change {
                operation: "delete".to_string(),
                path: source,
                move_path: None,
                overwritten: None,
            },
            AppliedPatchFileChange::Update {
                move_path,
                overwritten_move_content,
                ..
            } => Change {
                operation: if move_path.is_some() {
                    "move".to_string()
                } else {
                    "update".to_string()
                },
                path: source,
                move_path: move_path.as_ref().map(path_string),
                overwritten: move_path
                    .as_ref()
                    .map(|_| overwritten_move_content.is_some()),
            },
        };
        changes.push(item);
    }
    changes
}

async fn run(request: Request) -> Result<Response, HelperError> {
    if request.version != 1 {
        return Err(HelperError::new(
            "PROTOCOL_VERSION_UNSUPPORTED",
            format!("Unsupported helper protocol version: {}", request.version),
        ));
    }
    if request.patch.as_bytes().len() > MAX_PATCH_BYTES {
        return Err(HelperError::new(
            "PATCH_TOO_LARGE",
            format!("Patch exceeds the {MAX_PATCH_BYTES}-byte limit."),
        ));
    }
    if request.max_files == 0 || request.max_files > 100 {
        return Err(HelperError::new(
            "MAX_FILES_INVALID",
            "maxFiles must be between 1 and 100.",
        ));
    }
    if request.workspace_roots.is_empty() {
        return Err(HelperError::new(
            "NO_WORKSPACES",
            "At least one approved workspace root is required.",
        ));
    }

    let cwd = PathBuf::from(&request.cwd);
    if !cwd.is_absolute() {
        return Err(HelperError::new(
            "CWD_NOT_ABSOLUTE",
            "cwd must be an absolute path.",
        ));
    }
    let roots = request
        .workspace_roots
        .iter()
        .map(|root| canonicalize_nearest(Path::new(root)))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            HelperError::new(
                "WORKSPACE_RESOLUTION_FAILED",
                format!("Failed to resolve workspace roots: {error}"),
            )
        })?;
    ensure_confined(&cwd, &roots)?;

    let args = parse_patch(&request.patch).map_err(|error| {
        HelperError::new("PATCH_INVALID", format!("Patch parsing failed: {error}"))
    })?;
    validate_hunk_paths(&args.hunks)?;
    let cwd_uri = PathUri::from_host_native_path(&cwd).map_err(|error| {
        HelperError::new("CWD_URI_INVALID", format!("Failed to encode cwd: {error}"))
    })?;
    let action = match verify_apply_patch_args(args, &cwd_uri, LOCAL_FS.as_ref(), None).await {
        MaybeApplyPatchVerified::Body(action) => action,
        MaybeApplyPatchVerified::CorrectnessError(error) => {
            return Err(HelperError::new(
                "PATCH_VERIFICATION_FAILED",
                error.to_string(),
            ));
        }
        MaybeApplyPatchVerified::ShellParseError(error) => {
            return Err(HelperError::new(
                "PATCH_VERIFICATION_FAILED",
                format!("Unexpected shell parse error: {error:?}"),
            ));
        }
        MaybeApplyPatchVerified::NotApplyPatch => {
            return Err(HelperError::new(
                "PATCH_VERIFICATION_FAILED",
                "Input was not recognized as an apply_patch operation.",
            ));
        }
    };

    let affected_paths = action_paths(&action);
    if affected_paths.len() > request.max_files {
        return Err(HelperError::new(
            "PATCH_FILE_LIMIT_EXCEEDED",
            format!(
                "Patch affects {} source/destination paths; maxFiles is {}.",
                affected_paths.len(),
                request.max_files
            ),
        ));
    }
    for affected in &affected_paths {
        ensure_confined(affected, &roots)?;
    }
    ensure_overwrite_policy(&action, request.allow_overwrite)?;
    let planned_changes = action_changes(&action);
    if request.dry_run {
        return Ok(Response {
            success: true,
            dry_run: true,
            partial_applied: false,
            delta_exact: true,
            changes: planned_changes,
            error: None,
        });
    }

    let preferences = if request.preserve_line_endings {
        line_ending_preferences(&action)
    } else {
        HashMap::new()
    };
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    match codex_apply_patch::apply_patch(
        &request.patch,
        &cwd_uri,
        &mut stdout,
        &mut stderr,
        LOCAL_FS.as_ref(),
        None,
    )
    .await
    {
        Ok(delta) => {
            if request.preserve_line_endings {
                preserve_committed_line_endings(&delta, &preferences)?;
            }
            Ok(Response {
                success: true,
                dry_run: false,
                partial_applied: false,
                delta_exact: delta.is_exact(),
                changes: delta_changes(&delta),
                error: None,
            })
        }
        Err(failure) => {
            let (error, delta) = failure.into_parts();
            let preservation_error = if request.preserve_line_endings {
                preserve_committed_line_endings(&delta, &preferences).err()
            } else {
                None
            };
            let message = preservation_error
                .as_ref()
                .map(|item| format!("{}; {}", error, item.message))
                .unwrap_or_else(|| error.to_string());
            Ok(Response {
                success: false,
                dry_run: false,
                partial_applied: !delta.is_empty(),
                delta_exact: delta.is_exact() && preservation_error.is_none(),
                changes: delta_changes(&delta),
                error: Some(ErrorBody {
                    code: preservation_error
                        .map(|item| item.code.to_string())
                        .unwrap_or_else(|| "PATCH_APPLY_FAILED".to_string()),
                    message,
                }),
            })
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut input = String::new();
    let read_result = io::stdin().lock().read_line(&mut input);
    let response = match read_result {
        Ok(0) => failure_response(
            false,
            HelperError::new("REQUEST_MISSING", "Expected one JSON request line on stdin."),
        ),
        Ok(_) => match serde_json::from_str::<Request>(&input) {
            Ok(request) => {
                let dry_run = request.dry_run;
                match run(request).await {
                    Ok(response) => response,
                    Err(error) => failure_response(dry_run, error),
                }
            }
            Err(error) => failure_response(
                false,
                HelperError::new("REQUEST_INVALID", format!("Invalid JSON request: {error}")),
            ),
        },
        Err(error) => failure_response(
            false,
            HelperError::new("REQUEST_READ_FAILED", format!("Failed to read stdin: {error}")),
        ),
    };
    let serialized = serde_json::to_string(&response).unwrap_or_else(|error| {
        format!(
            "{{\"success\":false,\"dryRun\":false,\"partialApplied\":false,\"deltaExact\":false,\"changes\":[],\"error\":{{\"code\":\"SERIALIZATION_FAILED\",\"message\":{}}}}}",
            serde_json::to_string(&error.to_string()).unwrap_or_else(|_| "\"unknown\"".to_string())
        )
    });
    println!("{serialized}");
    let _ = io::stdout().flush();
    if !response.success {
        std::process::exit(1);
    }
}
