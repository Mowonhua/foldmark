//! 文件职责：向设置界面提供系统已安装字体的族名列表。
//! 定义范围：字体枚举命令与会话内缓存；不解析字形、样式或字体文件内容。

use std::sync::Mutex;

/// 会话内字体列表缓存；字体安装状态在应用运行期视为不变。
static FAMILIES_CACHE: Mutex<Option<Vec<String>>> = Mutex::new(None);

/// 函数职责：枚举系统字体族名，供字体选择器点选。
/// 输入说明：无参数；重复调用返回同一列表。
/// 输出说明：按不区分大小写字典序排序的去重族名；枚举失败返回可直接显示的中文错误。
/// 实现思路：fontdb 扫描系统字体目录并读取 name 表；首次枚举较慢，放到阻塞线程池，结果缓存到进程退出。
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(cached_families)
        .await
        .map_err(|error| format!("无法枚举系统字体：{error}"))?
}

/// 函数职责：返回缓存的族名列表，缺失时枚举一次并写入缓存。
/// 输出说明：缓存锁不可用或枚举失败时返回可显示的中文错误。
fn cached_families() -> Result<Vec<String>, String> {
    let mut cache = FAMILIES_CACHE
        .lock()
        .map_err(|_| "系统字体缓存不可用。".to_owned())?;
    if let Some(families) = cache.as_ref() {
        return Ok(families.clone());
    }
    let families = enumerate_families()?;
    *cache = Some(families.clone());
    Ok(families)
}

/// 函数职责：扫描系统字体并收集去重后的族名。
/// 输出说明：同一字体族的多个字形变体只产生一项；名称取该字体的英文名（fontdb 保证首个族名为英文美国），跨平台展示一致。
/// 实现思路：按小写形式去重，再按不区分大小写的字典序排序，保证选择器列表稳定。
fn enumerate_families() -> Result<Vec<String>, String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    if database.len() == 0 {
        return Err("未在系统中找到任何字体。".to_owned());
    }
    let mut seen = std::collections::HashSet::new();
    let mut families = Vec::new();
    for face in database.faces() {
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        if name.is_empty() || !seen.insert(name.to_lowercase()) {
            continue;
        }
        families.push(name.clone());
    }
    families.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));
    Ok(families)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerated_families_are_sorted_and_case_insensitively_unique() {
        let families = enumerate_families().expect("测试环境应能枚举系统字体");
        assert!(!families.is_empty(), "测试环境至少安装一个字体");
        let mut expected = families.iter().map(|name| name.to_lowercase()).collect::<Vec<_>>();
        expected.sort();
        expected.dedup();
        let actual = families.iter().map(|name| name.to_lowercase()).collect::<Vec<_>>();
        assert_eq!(actual, expected, "族名必须按小写字典序排序且不区分大小写去重");
    }

    #[test]
    fn cached_families_reuse_the_first_enumeration() {
        let first = cached_families().expect("首次枚举应成功");
        let second = cached_families().expect("缓存读取应成功");
        assert_eq!(first, second);
    }
}
