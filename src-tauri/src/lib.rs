//! 文件职责：连接桌面命令与文件基础设施。
//! 定义范围：Tauri 启动入口和平台命令适配。
mod external_link;
mod recovery;
mod storage;
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

#[tauri::command]
fn watch_file(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, FileState>,
) -> Result<u64, FileError> {
    let watch_id = state.next_watch.fetch_add(1, Ordering::Relaxed);
    let watcher = watch_path(Path::new(&path), move || {
        let _ = app.emit("foldmark:file-change", watch_id);
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(FileState::default())
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
            watch_file,
            unwatch_file
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 Foldmark 桌面窗口");
}

#[cfg(test)]
mod tests {
    use super::*;
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
