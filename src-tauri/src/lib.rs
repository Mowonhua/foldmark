//! 文件职责：连接桌面命令与文件基础设施。
//! 定义范围：Tauri 启动入口和平台命令适配。
mod external_link;
mod recovery;
#[cfg(target_os = "windows")]
mod single_instance;
mod storage;
mod sync;
mod system_fonts;
mod window_material;
#[cfg(not(target_os = "android"))]
mod window_state;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use storage::{FileError, FileSnapshot};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// 结构职责：保持进程内磁盘操作顺序并持有监听生命周期。
/// 字段说明：gate 只在后台阻塞线程使用；watchers 由订阅编号显式移除。
/// 约束条件：同一应用所有写入必须经过 gate，调用方仍须串行提交同文档快照。
#[derive(Default)]
struct FileState {
    gate: Arc<Mutex<()>>,
    watchers: Mutex<HashMap<u64, RecommendedWatcher>>,
    next_watch: AtomicU64,
}

/// 文件 IO 与等待互斥锁都在阻塞线程池中执行，避免阻塞 WebView 输入事件。
async fn disk<T: Send + 'static>(
    gate: Arc<Mutex<()>>,
    operation: impl FnOnce() -> Result<T, FileError> + Send + 'static,
) -> Result<T, FileError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate
            .lock()
            .map_err(|_| FileError::new("FILE_INTERNAL", "文件锁不可用。"))?;
        operation()
    })
    .await
    .map_err(|error| FileError::new("FILE_INTERNAL", error.to_string()))?
}

fn state_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, FileError> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(name))
        .map_err(|error| FileError::new("STATE_PATH", error.to_string()))
}

/// Windows 的大小写和分隔符不应让同一关联产生多份恢复草稿；文件缺失时仍保留可寻址的草稿键。
fn recovery_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, FileError> {
    let identity = storage::file_identity(path);
    state_path(
        app,
        &format!(
            "recovery/{}.json",
            storage::fingerprint(identity.as_bytes())
        ),
    )
}

#[tauri::command]
async fn read_file(path: String, state: State<'_, FileState>) -> Result<FileSnapshot, FileError> {
    disk(state.gate.clone(), move || storage::read(Path::new(&path))).await
}

#[tauri::command]
async fn canonical_file_path(
    path: String,
    create: bool,
    state: State<'_, FileState>,
) -> Result<String, FileError> {
    disk(state.gate.clone(), move || {
        storage::canonical_path(Path::new(&path), create)
    })
    .await
}

#[tauri::command]
async fn open_external_link(url: String, app: tauri::AppHandle) -> Result<(), FileError> {
    let validated = external_link::validated_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.opener()
            .open_url(validated, None::<&str>)
            .map_err(|error| FileError::new("LINK_OPEN", error.to_string()))
    })
    .await
    .map_err(|error| FileError::new("LINK_OPEN", error.to_string()))?
}

/// 本地资源打开独立于正文持久化；文件存在性与类型校验在后台线程执行。
#[tauri::command]
async fn open_local_document(path: String, app: tauri::AppHandle) -> Result<(), FileError> {
    tauri::async_runtime::spawn_blocking(move || {
        let validated = external_link::validated_local_document(Path::new(&path))?;
        app.opener()
            .open_path(validated, None::<&str>)
            .map_err(|error| FileError::new("LINK_OPEN", error.to_string()))
    })
    .await
    .map_err(|error| FileError::new("LINK_OPEN", error.to_string()))?
}

#[tauri::command]
async fn write_file(
    path: String,
    text: String,
    expected_revision: String,
    state: State<'_, FileState>,
) -> Result<FileSnapshot, FileError> {
    disk(state.gate.clone(), move || {
        storage::write(Path::new(&path), &text, &expected_revision)
    })
    .await
}

#[tauri::command]
async fn create_file(
    path: String,
    text: String,
    state: State<'_, FileState>,
) -> Result<FileSnapshot, FileError> {
    disk(state.gate.clone(), move || {
        storage::create(Path::new(&path), &text)
    })
    .await
}

#[tauri::command]
async fn load_config(
    app: tauri::AppHandle,
    state: State<'_, FileState>,
) -> Result<Option<Value>, FileError> {
    let path = state_path(&app, "config.json")?;
    disk(state.gate.clone(), move || storage::load_json(&path)).await
}

#[tauri::command]
async fn save_config(
    config: Value,
    app: tauri::AppHandle,
    state: State<'_, FileState>,
) -> Result<(), FileError> {
    let path = state_path(&app, "config.json")?;
    disk(state.gate.clone(), move || {
        storage::save_json(&path, &config)
    })
    .await
}

#[tauri::command]
async fn load_recovery(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, FileState>,
) -> Result<Option<recovery::RecoveryDraft>, FileError> {
    let stored_path = recovery_path(&app, &path)?;
    disk(state.gate.clone(), move || {
        recovery::load(&stored_path, &path)
    })
    .await
}

#[tauri::command]
async fn save_recovery(
    draft: Value,
    app: tauri::AppHandle,
    state: State<'_, FileState>,
) -> Result<(), FileError> {
    let original_path = draft
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let draft = recovery::validate(draft, &original_path)?;
    let path = recovery_path(&app, &original_path)?;
    disk(state.gate.clone(), move || recovery::save(&path, &draft)).await
}

#[tauri::command]
async fn clear_recovery(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, FileState>,
) -> Result<(), FileError> {
    let stored_path = recovery_path(&app, &path)?;
    disk(state.gate.clone(), move || {
        recovery::clear(&stored_path, &path)
    })
    .await
}

/// 删除仅限应用私有 documents 目录中的 Markdown 副本；必须先结束编辑保存与同步写入。
/// 路径核验先于草稿清理，拒绝符号链接和越界路径；重复删除视为成功。
fn delete_managed_document(path: &Path, root: &Path, draft: &Path) -> Result<(), FileError> {
    let root = std::fs::canonicalize(root).map_err(FileError::io)?;
    let parent = path.parent().ok_or_else(|| FileError::new("FILE_PATH", "私有文档路径无效。"))?;
    if std::fs::canonicalize(parent).map_err(FileError::io)? != root || path.extension().and_then(|part| part.to_str()) != Some("md") {
        return Err(FileError::new("FILE_PATH", "只能删除应用私有目录中的 Markdown 副本。"));
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => return Err(FileError::new("FILE_PATH", "不能删除目录或链接文件。")),
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(FileError::io(error)),
    }
    recovery::clear(draft, &path.to_string_lossy())?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(FileError::io(error)),
    }
}

#[tauri::command]
async fn delete_managed_file(path: String, app: tauri::AppHandle, state: State<'_, FileState>) -> Result<(), FileError> {
    if !cfg!(target_os = "android") { return Err(FileError::new("FILE_UNSUPPORTED", "桌面端只移除文件关联。")); }
    let root = state_path(&app, "documents")?;
    let draft = recovery_path(&app, &path)?;
    disk(state.gate.clone(), move || delete_managed_document(Path::new(&path), &root, &draft)).await
}

#[tauri::command]
fn watch_file(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, FileState>,
) -> Result<u64, FileError> {
    let watch_id = state.next_watch.fetch_add(1, Ordering::Relaxed);
    let watcher = watch_path(Path::new(&path), move || {
        let _ = app.emit("taskrail:file-change", watch_id);
    })?;
    state
        .watchers
        .lock()
        .map_err(|_| FileError::new("FILE_INTERNAL", "文件监听锁不可用。"))?
        .insert(watch_id, watcher);
    Ok(watch_id)
}

/// 保持目录订阅独立于桌面事件总线，使原子替换、删除和重建行为可直接验证。
fn watch_path(
    path: &Path,
    on_change: impl Fn() + Send + 'static,
) -> Result<RecommendedWatcher, FileError> {
    let target = std::fs::canonicalize(path).map_err(FileError::io)?;
    let parent = target
        .parent()
        .ok_or_else(|| FileError::new("FILE_PATH", "文件没有父目录。"))?
        .to_path_buf();
    // 监听父目录才能在原子替换后继续收到通知；读操作事件不能触发再读取的反馈循环。
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let changed = match event {
            Ok(event) => {
                !matches!(event.kind, notify::EventKind::Access(_))
                    && event.paths.iter().any(|entry| entry == &target)
            }
            Err(_) => true,
        };
        if changed {
            on_change();
        }
    })
    .map_err(|error| FileError::new("FILE_WATCH", error.to_string()))?;
    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|error| FileError::new("FILE_WATCH", error.to_string()))?;
    Ok(watcher)
}

#[tauri::command]
fn unwatch_file(watch_id: u64, state: State<'_, FileState>) -> Result<(), FileError> {
    state
        .watchers
        .lock()
        .map_err(|_| FileError::new("FILE_INTERNAL", "文件监听锁不可用。"))?
        .remove(&watch_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    let _instance = match single_instance::acquire().expect("无法仲裁 Taskrail 启动实例") {
        Some(instance) => instance,
        None => return,
    };
    let mut context = tauri::generate_context!();
    // 插件注册时读取配置；必须在运行前选择通道，正式版不能收到预发布更新。
    let channel = if context.package_info().version.pre.is_empty() {
        "stable"
    } else {
        "preview"
    };
    context
        .config_mut()
        .plugins
        .0
        .get_mut("updater")
        .expect("更新配置缺失")["endpoints"] = serde_json::json!([format!(
        "https://raw.githubusercontent.com/Mowonhua/taskrail/updates/{channel}.json"
    )]);
    #[cfg(target_os = "windows")]
    let window_key = _instance.window_key();
    // 互斥锁已先于 Tauri 初始化获取，并保持到事件循环退出。
    let builder = tauri::Builder::default().setup(move |app| {
        #[cfg(target_os = "windows")]
        single_instance::mark_window(app, &window_key)?;
        // 窗口此时尚未显示，恢复上次几何不会露出移动过程。
        #[cfg(not(target_os = "android"))]
        window_state::restore(app);
        #[cfg(target_os = "android")]
        app.handle().plugin(tauri_plugin_taskrail_mobile::init())?;
        Ok(())
    });
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .manage(FileState::default())
        .manage(sync::SyncState::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            canonical_file_path,
            open_external_link,
            open_local_document,
            write_file,
            create_file,
            load_config,
            save_config,
            load_recovery,
            save_recovery,
            clear_recovery,
            delete_managed_file,
            watch_file,
            unwatch_file,
            sync::sync_status, sync::sync_offer, sync::sync_pair, sync::sync_approve,
            sync::sync_unpair, sync::sync_address, sync::sync_exchange, sync::sync_respond,
            sync::sync_probe, sync::sync_notify, sync::sync_disconnect,
            sync::sync_load_state, sync::sync_save_state,
            system_fonts::list_system_fonts,
            window_material::set_window_material
        ])
        .run(context)
        .expect("无法启动 Taskrail 桌面窗口");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_delete_removes_private_document_and_draft_but_rejects_external_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("documents"); std::fs::create_dir(&root).unwrap();
        let path = root.join("owned.md"); let external = directory.path().join("original.md");
        let draft = directory.path().join("recovery.json");
        storage::create(&path, "副本").unwrap(); storage::create(&external, "原文").unwrap();
        recovery::save(&draft, &recovery::RecoveryDraft { path: path.to_string_lossy().into_owned(), text: "副本".into(), base_revision: "base".into(), saved_at: 1 }).unwrap();
        assert!(delete_managed_document(&external, &root, &draft).is_err());
        assert!(draft.exists()); assert_eq!(storage::read(&external).unwrap().text, "原文");
        delete_managed_document(&path, &root, &draft).unwrap();
        assert!(!path.exists()); assert!(!draft.exists());
        delete_managed_document(&path, &root, &draft).unwrap();
    }
    #[test]
    fn concurrent_saves_from_same_revision_accept_only_one() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.md");
        let initial = storage::create(&path, "initial").unwrap();
        let gate = Arc::new(Mutex::new(()));
        let first_path = path.clone();
        let second_path = path.clone();
        let first_revision = initial.revision.clone();
        let first = tauri::async_runtime::spawn(disk(gate.clone(), move || {
            storage::write(&first_path, "one", &first_revision)
        }));
        let second = tauri::async_runtime::spawn(disk(gate, move || {
            storage::write(&second_path, "two", &initial.revision)
        }));
        let first = tauri::async_runtime::block_on(first).unwrap();
        let second = tauri::async_runtime::block_on(second).unwrap();
        assert_ne!(first.is_ok(), second.is_ok());
        let rejected = first.as_ref().err().or(second.as_ref().err()).unwrap();
        assert_eq!(rejected.code, "FILE_CONFLICT");
        let accepted = first.ok().or(second.ok()).unwrap();
        assert_eq!(storage::read(&path).unwrap().text, accepted.text);
    }

    #[test]
    fn directory_watch_survives_atomic_replace_and_file_recreation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.md");
        let original = storage::create(&path, "initial").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let _watcher = watch_path(&path, move || {
            let _ = sender.send(());
        })
        .unwrap();
        storage::write(&path, "replaced", &original.revision).unwrap();
        receiver
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("原子替换必须触发通知");
        std::fs::remove_file(&path).unwrap();
        receiver
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("删除必须触发通知");
        while receiver.try_recv().is_ok() {}
        storage::create(&path, "recreated").unwrap();
        receiver
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("重新创建必须继续触发通知");
    }
}
