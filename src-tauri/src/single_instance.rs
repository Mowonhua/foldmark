//! 按可执行文件的规范路径仲裁 Windows 启动，并在重复启动时激活已有主窗口。
//! 互斥锁必须先于 Tauri 初始化获取；窗口属性只发布激活目标，不承担互斥职责。

use std::{
    io,
    path::Path,
    time::{Duration, Instant},
};
use tauri::Manager;
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, HANDLE, HWND, LPARAM, LRESULT, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
        WPARAM,
    },
    System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            EnumWindows, GetPropW, IsIconic, IsWindow, RemovePropW, SetForegroundWindow, SetPropW,
            ShowWindowAsync, SW_RESTORE, SW_SHOW, WM_NCDESTROY,
        },
    },
};

/// 只允许获取锁的线程持有并释放所有权；原生指针使此类型不能跨线程移动。
/// 次进程等待期间也持有句柄，所以必须判断锁所有权，不能仅凭命名对象是否存在判重。
pub struct InstanceGuard {
    handle: HANDLE,
    owns_mutex: bool,
    window_key: Vec<u16>,
}

impl InstanceGuard {
    pub fn window_key(&self) -> Vec<u16> {
        self.window_key.clone()
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        // 句柄始终来自 CreateMutexW；只有成功等待取得所有权的线程才能释放锁。
        unsafe {
            if self.owns_mutex {
                ReleaseMutex(self.handle);
            }
            CloseHandle(self.handle);
        }
    }
}

fn instance_key(executable: &Path) -> io::Result<Vec<u16>> {
    let canonical = std::fs::canonicalize(executable)?;
    // 使用完整路径而非文件内容、文件名或应用 ID；复制、改名后的程序各自独立。
    // 规范化路径消除相对路径与链接差异，沿用文件身份的 Windows 大小写及分隔符规则。
    let path = canonical
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "程序路径包含无效 Unicode"))?;
    let identity = crate::storage::file_identity(path);
    let hash = crate::storage::fingerprint(identity.as_bytes());
    Ok(format!("Foldmark.Instance.{hash}")
        .encode_utf16()
        .chain([0])
        .collect())
}

/// Some 表示当前线程成为主实例；None 表示已激活已有窗口或等待窗口发布已超时。
/// 主实例在窗口发布前退出时允许接管；等待超时或原生 API 失败都不能放行第二窗口。
pub fn acquire() -> io::Result<Option<InstanceGuard>> {
    let window_key = instance_key(&std::env::current_exe()?)?;
    // Local 限定当前 Windows 会话，避免其他登录会话的窗口阻止本会话启动。
    let mutex_name: Vec<u16> = "Local\\"
        .encode_utf16()
        .chain(window_key.iter().copied())
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut guard = InstanceGuard {
        handle,
        owns_mutex: false,
        window_key,
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        // 创建命名对象与取得所有权是两个步骤；所有启动者用同一个原子等待进行仲裁。
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => {
                guard.owns_mutex = true;
                return Ok(Some(guard));
            }
            WAIT_TIMEOUT => {}
            _ => return Err(io::Error::last_os_error()),
        }
        if activate_window(&guard.window_key)? || Instant::now() >= deadline {
            return Ok(None);
        }
        // 主实例可能还没有完成 WebView 初始化；等待时绝不创建第二个窗口。
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// setup 在窗口所属主线程发布激活标记，并注册实际销毁时的属性清理。
/// 不在关闭请求时清理：前端可能因保存失败取消关闭，此时窗口仍必须能够被激活。
pub fn mark_window(app: &tauri::App, key: &[u16]) -> io::Result<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "主窗口不存在"))?;
    let hwnd = window.hwnd().map_err(io::Error::other)?.0 as HWND;
    // setup 的捕获值会在返回后释放，回调因此独立持有键，并在 WM_NCDESTROY 回收。
    let marker = Box::into_raw(Box::new(key.to_vec()));
    if unsafe { SetWindowSubclass(hwnd, Some(cleanup_window), 0, marker as usize) } == 0 {
        unsafe {
            drop(Box::from_raw(marker));
        }
        return Err(io::Error::other("无法注册主窗口销毁回调"));
    }
    // 属性值只是非空标记，绝不作为指针解引用；实例身份完全由属性名确定。
    if unsafe { SetPropW(hwnd, key.as_ptr(), 1usize as HANDLE) } == 0 {
        let error = io::Error::last_os_error();
        // 移除成功后才释放回调数据；失败时仍交由窗口销毁回调持有，避免悬空指针。
        if unsafe { RemoveWindowSubclass(hwnd, Some(cleanup_window), 0) } != 0 {
            unsafe {
                drop(Box::from_raw(marker));
            }
        }
        return Err(error);
    }
    Ok(())
}

unsafe extern "system" fn cleanup_window(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    marker: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        // 成功注册后 marker 只由此回调拥有；原生销毁消息到达时窗口句柄仍有效。
        let key = Box::from_raw(marker as *mut Vec<u16>);
        RemovePropW(hwnd, key.as_ptr());
        RemoveWindowSubclass(hwnd, Some(cleanup_window), subclass_id);
    }
    // 必须继续原窗口过程，保留 Tauri 的销毁与其他消息处理。
    DefSubclassProc(hwnd, message, wparam, lparam)
}

struct WindowSearch<'a> {
    key: &'a [u16],
    found: HWND,
}

unsafe extern "system" fn find_window(hwnd: HWND, parameter: LPARAM) -> i32 {
    // EnumWindows 同步执行回调，parameter 只在调用期间指向栈上的 WindowSearch。
    let search = &mut *(parameter as *mut WindowSearch<'_>);
    if !GetPropW(hwnd, search.key.as_ptr()).is_null() {
        search.found = hwnd;
    }
    1
}

fn activate_window(key: &[u16]) -> io::Result<bool> {
    let mut search = WindowSearch {
        key,
        found: std::ptr::null_mut(),
    };
    if unsafe { EnumWindows(Some(find_window), &mut search as *mut _ as LPARAM) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let hwnd = search.found;
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return Ok(false);
    }
    // 仅最小化窗口执行还原，普通及最大化窗口只显示，保留用户的窗口尺寸状态。
    // 从新启动的进程激活，利用 Explorer 等前台启动者授予的前台切换权限。
    // 异步显示避免主窗口初始化或短暂忙碌时阻塞次进程；系统仍可拒绝抢占焦点。
    unsafe {
        let command = if IsIconic(hwnd) != 0 {
            SW_RESTORE
        } else {
            SW_SHOW
        };
        if ShowWindowAsync(hwnd, command) == 0 {
            return Ok(false);
        }
        SetForegroundWindow(hwnd);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_path_defines_instance_scope() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let program = first.join("foldmark.exe");
        let copy = second.join("foldmark.exe");
        let renamed = first.join("other.exe");
        for path in [&program, &copy, &renamed] {
            std::fs::write(path, "same executable bytes").unwrap();
        }
        let identity = instance_key(&program).unwrap();
        assert_eq!(
            identity,
            instance_key(&first.join(".\\foldmark.exe")).unwrap()
        );
        assert_eq!(identity, instance_key(&first.join("FOLDMARK.EXE")).unwrap());
        assert_ne!(identity, instance_key(&copy).unwrap());
        assert_ne!(identity, instance_key(&renamed).unwrap());
    }
}
