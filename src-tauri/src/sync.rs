//! 文件职责：提供有界的 TLS 局域网连接、配对与同步状态存储。
//! 定义范围：凭证留在原生端；只有已认证消息才进入前端文档协调器。
use crate::storage;
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::{rngs::OsRng, RngCore};
use rustls::{pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName}, ClientConfig, ClientConnection, RootCertStore, ServerConfig, ServerConnection, StreamOwned};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, io::{Read, Write}, net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket, Shutdown}, path::PathBuf, sync::{atomic::{AtomicUsize, Ordering}, mpsc, Arc, Mutex, OnceLock}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};
mod connection;

const LIMIT: usize = 8 * 1024 * 1024;
const SERVICE: &str = "_taskrail._tcp.local.";
type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize, Deserialize)]
struct Peer { id: String, secret: String, address: String, certificate: Vec<u8> }
#[derive(Serialize, Deserialize)]
struct Credentials { certificate: Vec<u8>, key: Vec<u8>, id: String, secret: String, peer: Option<Peer> }
#[derive(Clone, Serialize, Deserialize)]
pub struct Offer { version: u8, address: String, #[serde(default)] addresses: Vec<String>, certificate: Vec<u8>, token: String, expires: u64 }
struct Inner { credentials: Credentials, offer: Option<Offer>, pending: Option<Peer>, port: Option<u16>, daemon: Option<ServiceDaemon> }
/** 已认证连接的唯一发送入口；id 区分重连代次，socket 仅用于主动中断阻塞读取。 */
struct LiveConnection { id: String, session: String, sender: mpsc::SyncSender<connection::Command>, socket: TcpStream }
struct Runtime {
    inner: Mutex<Inner>, directory: PathBuf, responses: Mutex<HashMap<String, mpsc::SyncSender<Result<Value>>>>,
    connection: Mutex<Option<LiveConnection>>, connection_start: Mutex<()>, connection_epoch: AtomicUsize,
}
#[derive(Default)]
pub struct SyncState { runtime: OnceLock<Arc<Runtime>>, initialization: Mutex<()> }

fn random() -> String { let mut bytes = [0; 32]; OsRng.fill_bytes(&mut bytes); storage::fingerprint(&bytes) }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn err(error: impl std::fmt::Display) -> String { error.to_string() }
fn local(address: SocketAddr) -> bool { match address.ip() { IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(), _ => false } }
fn address(value: &str) -> Result<SocketAddr> {
    let address: SocketAddr = value.parse().map_err(|_| "请输入局域网 IPv4 地址和端口，例如 192.168.1.10:12345")?;
    if !local(address) || address.port() == 0 { return Err("仅支持局域网 IPv4 地址".into()); } Ok(address)
}
fn default_ip() -> String {
    UdpSocket::bind("0.0.0.0:0").and_then(|socket| { socket.connect("192.0.2.1:80")?; socket.local_addr() }).map(|address| address.ip().to_string()).unwrap_or_else(|_| "127.0.0.1".into())
}
/** 默认路由可能属于 VPN；优先提供无线网卡，并保留其他局域网地址供用户选择。 */
fn local_addresses(port: u16) -> Vec<String> {
    let default = default_ip();
    let mut interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    interfaces.retain(|interface| matches!(interface.ip(), IpAddr::V4(ip) if ip.is_private()));
    interfaces.sort_by_key(|interface| {
        let name = interface.name.to_lowercase();
        if ["wlan", "wi-fi", "wifi", "无线"].iter().any(|word| name.contains(word)) { 0 }
        else if interface.ip().to_string() == default { 1 } else { 2 }
    });
    let mut addresses: Vec<String> = interfaces.into_iter().map(|interface| format!("{}:{port}", interface.ip())).collect();
    addresses.dedup();
    if addresses.is_empty() { addresses.push(format!("{default}:{port}")); }
    addresses
}
fn save_credentials(runtime: &Runtime, inner: &Inner) -> Result<()> {
    storage::save_json(&runtime.directory.join("identity.json"), &serde_json::to_value(&inner.credentials).map_err(err)?).map_err(|e| e.message)
}
fn runtime(app: &tauri::AppHandle, state: &SyncState) -> Result<Arc<Runtime>> {
    let _initialization = state.initialization.lock().map_err(err)?;
    if let Some(value) = state.runtime.get() { return Ok(value.clone()); }
    let directory = app.path().app_data_dir().map_err(err)?.join("sync");
    let credentials = match storage::load_json(&directory.join("identity.json")).map_err(|e| e.message)? {
        Some(value) => serde_json::from_value(value).map_err(err)?,
        None => {
            let cert = rcgen::generate_simple_self_signed(vec!["taskrail.local".into()]).map_err(err)?;
            Credentials { certificate: cert.cert.der().to_vec(), key: cert.key_pair.serialize_der(), id: random(), secret: random(), peer: None }
        }
    };
    let value = Arc::new(Runtime { inner: Mutex::new(Inner { credentials, offer: None, pending: None, port: None, daemon: None }), directory, responses: Mutex::new(HashMap::new()), connection: Mutex::new(None), connection_start: Mutex::new(()), connection_epoch: AtomicUsize::new(0) });
    save_credentials(&value, &*value.inner.lock().map_err(err)?)?;
    let _ = state.runtime.set(value.clone()); Ok(value)
}
/** 长度前缀在分配前检查；超大消息或截断消息均不能进入文档协调器。 */
fn read_frame(stream: &mut impl Read) -> Result<Value> {
    let mut header = [0; 4]; stream.read_exact(&mut header).map_err(err)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > LIMIT { return Err("SYNC_LIMIT: 同步消息过大".into()); }
    let mut bytes = vec![0; length]; stream.read_exact(&mut bytes).map_err(err)?;
    serde_json::from_slice(&bytes).map_err(err)
}
fn write_frame(stream: &mut impl Write, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(err)?;
    if bytes.len() > LIMIT { return Err("SYNC_LIMIT: 同步消息过大".into()); }
    stream.write_all(&(bytes.len() as u32).to_be_bytes()).map_err(err)?;
    stream.write_all(&bytes).map_err(err)?; stream.flush().map_err(err)
}
fn start(app: &tauri::AppHandle, runtime: &Arc<Runtime>) -> Result<()> {
    if cfg!(target_os = "android") { return Err("手机通过电脑提供的地址连接".into()); }
    let mut inner = runtime.inner.lock().map_err(err)?;
    if inner.port.is_some() { return Ok(()); }
    let config = ServerConfig::builder().with_no_client_auth().with_single_cert(
        vec![CertificateDer::from(inner.credentials.certificate.clone())],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(inner.credentials.key.clone()))).map_err(err)?;
    let listener = TcpListener::bind("0.0.0.0:0").map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let fingerprint = storage::fingerprint(&inner.credentials.certificate);
    if let Ok(daemon) = ServiceDaemon::new() {
        if let Ok(info) = ServiceInfo::new(SERVICE, &format!("Taskrail-{}", &fingerprint[..12]), "taskrail.local.", "", port, [("identity", fingerprint.as_str())].as_slice()) {
            let _ = daemon.register(info.enable_addr_auto());
        }
        inner.daemon = Some(daemon);
    }
    inner.port = Some(port);
    let runtime = runtime.clone(); let app = app.clone(); let config = Arc::new(config);
    std::thread::spawn(move || {
        let connections = Arc::new(AtomicUsize::new(0));
        for socket in listener.incoming().flatten() {
            if !socket.peer_addr().map(local).unwrap_or(false) || connections.fetch_add(1, Ordering::SeqCst) >= 4 {
                if socket.peer_addr().map(local).unwrap_or(false) { connections.fetch_sub(1, Ordering::SeqCst); }
                continue;
            }
            let runtime = runtime.clone(); let app = app.clone(); let config = config.clone(); let connections = connections.clone();
            std::thread::spawn(move || {
                let _ = socket.set_read_timeout(Some(Duration::from_secs(35))); let _ = socket.set_write_timeout(Some(Duration::from_secs(35)));
                if let Ok(connection) = ServerConnection::new(config) {
                    let mut stream = StreamOwned::new(connection, socket);
                    match read_frame(&mut stream) {
                        Ok(request) if request["action"] == "stream" => { let _ = serve_stream(&app, &runtime, &mut stream, request); }
                        request => {
                            let response = request.and_then(|request| handle(&app, &runtime, request));
                            let value = match response { Ok(value) => json!({"ok": value}), Err(error) => json!({"error": error}) };
                            let _ = write_frame(&mut stream, &value);
                        }
                    }
                }
                connections.fetch_sub(1, Ordering::SeqCst);
            });
        }
    }); Ok(())
}
fn authenticated(inner: &Inner, request: &Value) -> bool {
    inner.credentials.peer.as_ref().is_some_and(|peer| request["id"].as_str() == Some(&peer.id) && request["secret"].as_str() == Some(&peer.secret))
}
fn handle(app: &tauri::AppHandle, runtime: &Runtime, request: Value) -> Result<Value> {
    if request["protocol"] != 1 { return Err("SYNC_PROTOCOL: 同步协议不兼容".into()); }
    let mut inner = runtime.inner.lock().map_err(err)?;
    if request["action"] == "pair" {
        if authenticated(&inner, &request) { return Ok(json!(true)); }
        if inner.credentials.peer.is_some() { return Err("已有配对设备，请先解除配对".into()); }
        let offer = inner.offer.as_ref().ok_or("配对已失效，请重新扫码")?;
        if offer.expires < now() || request["token"].as_str() != Some(&offer.token) { return Err("配对已过期或二维码不匹配".into()); }
        let id = request["id"].as_str().filter(|value| value.len() == 64).ok_or("设备身份无效")?;
        let secret = request["secret"].as_str().filter(|value| value.len() == 64).ok_or("设备身份无效")?;
        if inner.pending.as_ref().is_some_and(|pending| pending.id != id || pending.secret != secret) { return Err("另一个配对请求正在等待处理".into()); }
        inner.pending = Some(Peer { id: id.into(), secret: secret.into(), address: String::new(), certificate: vec![] });
        return Ok(json!(false));
    }
    if !authenticated(&inner, &request) { return Err("SYNC_AUTH: 设备未配对或配对已撤销".into()); }
    if request["action"] == "ping" { return Ok(Value::Null); }
    if request["action"] != "exchange" { return Err("SYNC_PROTOCOL: 未知同步操作".into()); }
    drop(inner);
    let result = frontend_exchange(app, runtime, request["envelope"].clone());
    if !authenticated(&*runtime.inner.lock().map_err(err)?, &request) { return Err("SYNC_AUTH: 配对已撤销".into()); }
    result
}
/** 短连接兼容入口与长连接共用相同的前端协调器及三十秒响应边界。 */
fn frontend_exchange(app: &tauri::AppHandle, runtime: &Runtime, envelope: Value) -> Result<Value> {
    let id = random(); let (sender, receiver) = mpsc::sync_channel(1);
    runtime.responses.lock().map_err(err)?.insert(id.clone(), sender);
    if let Err(error) = app.emit("taskrail:sync-request", json!({ "id": id, "envelope": envelope })) {
        runtime.responses.lock().map_err(err)?.remove(&id); return Err(err(error));
    }
    let result = receiver.recv_timeout(Duration::from_secs(30)).map_err(|_| "同步超时，内容保留，稍后重试".to_string()).and_then(|value| value);
    runtime.responses.lock().map_err(err)?.remove(&id);
    result
}
fn open_connection(peer: &Peer) -> Result<StreamOwned<ClientConnection, TcpStream>> {
    let mut roots = RootCertStore::empty(); roots.add(CertificateDer::from(peer.certificate.clone())).map_err(err)?;
    let config = ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    let connection = ClientConnection::new(Arc::new(config), ServerName::try_from("taskrail.local").map_err(err)?).map_err(err)?;
    let socket = TcpStream::connect_timeout(&address(&peer.address)?, Duration::from_secs(3)).map_err(err)?;
    socket.set_read_timeout(Some(Duration::from_secs(35))).map_err(err)?; socket.set_write_timeout(Some(Duration::from_secs(35))).map_err(err)?;
    Ok(StreamOwned::new(connection, socket))
}
fn connect(peer: &Peer, request: &Value) -> Result<Value> {
    let mut stream = open_connection(peer)?; write_frame(&mut stream, request)?;
    let response = read_frame(&mut stream)?;
    if let Some(error) = response["error"].as_str() { return Err(error.into()); }
    response.get("ok").cloned().ok_or_else(|| "SYNC_INVALID: 响应无效".into())
}
/** 发现仅提供地址提示；实际连接仍验证二维码固定的证书，伪造广播不能替换设备身份。 */
fn discover(peer: &Peer) -> Vec<String> {
    let Ok(daemon) = ServiceDaemon::new() else { return vec![]; };
    let Ok(receiver) = daemon.browse(SERVICE) else { let _ = daemon.shutdown(); return vec![]; };
    let expected = storage::fingerprint(&peer.certificate); let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut found = vec![];
    while std::time::Instant::now() < deadline {
        if let Ok(ServiceEvent::ServiceResolved(info)) = receiver.recv_timeout(Duration::from_millis(300)) {
            if info.get_property_val_str("identity") == Some(expected.as_str()) {
                found.extend(info.get_addresses().iter().filter(|ip| local(SocketAddr::new(**ip, info.get_port()))).map(|ip| format!("{ip}:{}", info.get_port())));
                if !found.is_empty() { break; }
            }
        }
    }
    let _ = daemon.stop_browse(SERVICE); let _ = daemon.shutdown(); found
}
/** 多网卡广播可能包含不可达地址；逐个验证证书，不把第一条广播当作连接成功。 */
fn connect_available(peer: &Peer, request: &Value) -> Result<(Value, String)> {
    match connect(peer, request) {
        Ok(value) => Ok((value, peer.address.clone())),
        Err(first) => {
            for address in discover(peer).into_iter().filter(|address| address != &peer.address).take(8) {
                let target = Peer { address: address.clone(), ..peer.clone() };
                if let Ok(value) = connect(&target, request) { return Ok((value, address)); }
            }
            Err(first)
        }
    }
}
/** 安装新连接时关闭旧代次；配对锁先于连接锁，撤销与重连不能安装过期凭证。 */
fn install_connection(runtime: &Runtime, session: &str, socket: &TcpStream, epoch: Option<usize>) -> Result<(String, mpsc::Receiver<connection::Command>)> {
    let inner = runtime.inner.lock().map_err(err)?;
    if inner.credentials.peer.as_ref().is_none_or(|peer| peer.secret != session) { return Err("SYNC_AUTH: 配对状态已变化".into()); }
    let id = random(); let (sender, receiver) = mpsc::sync_channel(8);
    let mut live = runtime.connection.lock().map_err(err)?;
    if epoch.is_some_and(|epoch| runtime.connection_epoch.load(Ordering::SeqCst) != epoch) { return Err("同步连接已停用".into()); }
    let next = LiveConnection { id: id.clone(), session: session.into(), sender, socket: socket.try_clone().map_err(err)? };
    if let Some(previous) = live.replace(next) { let _ = previous.socket.shutdown(Shutdown::Both); }
    Ok((id, receiver))
}
fn connection_current(runtime: &Runtime, id: &str, session: &str) -> bool {
    let Ok(inner) = runtime.inner.lock() else { return false; };
    if inner.credentials.peer.as_ref().is_none_or(|peer| peer.secret != session) { return false; }
    runtime.connection.lock().map(|live| live.as_ref().is_some_and(|live| live.id == id)).unwrap_or(false)
}
/** 清理只作用于自己的代次，旧线程退出不能关闭重连后建立的新连接。 */
fn remove_connection(runtime: &Runtime, id: Option<&str>) -> bool {
    let Ok(mut live) = runtime.connection.lock() else { return false; };
    if id.is_some_and(|id| live.as_ref().is_none_or(|live| live.id != id)) { return false; }
    if let Some(previous) = live.take() { let _ = previous.socket.shutdown(Shutdown::Both); return true; }
    false
}
fn serve_stream(app: &tauri::AppHandle, runtime: &Runtime, stream: &mut StreamOwned<ServerConnection, TcpStream>, request: Value) -> Result<()> {
    let session = {
        let inner = runtime.inner.lock().map_err(err)?;
        if request["protocol"] != 1 || !authenticated(&inner, &request) {
            write_frame(stream, &json!({"error":"SYNC_AUTH: 设备未配对或配对已撤销"}))?;
            return Err("SYNC_AUTH: 长连接认证失败".into());
        }
        inner.credentials.peer.as_ref().unwrap().secret.clone()
    };
    let (id, commands) = install_connection(runtime, &session, &stream.sock, None)?;
    let result = (|| {
        write_frame(stream, &json!({"ok":{"stream":1}}))?;
        stream.sock.set_read_timeout(Some(Duration::from_millis(100))).map_err(err)?;
        stream.sock.set_write_timeout(Some(Duration::from_secs(5))).map_err(err)?;
        connection::server(stream, commands, || connection_current(runtime, &id, &session), |envelope| frontend_exchange(app, runtime, envelope))
    })();
    remove_connection(runtime, Some(&id)); result
}
fn open_stream(peer: &Peer) -> Result<StreamOwned<ClientConnection, TcpStream>> {
    let mut stream = open_connection(peer)?;
    write_frame(&mut stream, &json!({"protocol":1,"action":"stream","id":peer.id,"secret":peer.secret}))?;
    let response = read_frame(&mut stream)?;
    if let Some(error) = response["error"].as_str() { return Err(error.into()); }
    if response["ok"]["stream"] != 1 { return Err("SYNC_PROTOCOL: 请更新两端应用以启用双向长连接".into()); }
    Ok(stream)
}
/** 手机只保留一个已认证的长连接；发现仍只提供地址，不能更换固定证书。 */
fn ensure_connection(app: &tauri::AppHandle, runtime: &Arc<Runtime>, epoch: usize) -> Result<()> {
    let _starting = runtime.connection_start.lock().map_err(err)?;
    if runtime.connection_epoch.load(Ordering::SeqCst) != epoch { return Err("同步连接已停用".into()); }
    let peer = runtime.inner.lock().map_err(err)?.credentials.peer.clone().ok_or("设备尚未配对")?;
    if runtime.connection.lock().map_err(err)?.as_ref().is_some_and(|live| live.session == peer.secret) { return Ok(()); }
    let (mut stream, endpoint) = match open_stream(&peer) {
        Ok(stream) => (stream, peer.address.clone()),
        Err(first) => {
            // 认证或协议错误不是地址错误，不通过发现重复尝试同一设备。
            if first.starts_with("SYNC_AUTH:") || first.starts_with("SYNC_PROTOCOL:") { return Err(first); }
            let mut found = None;
            for endpoint in discover(&peer).into_iter().filter(|value| value != &peer.address).take(8) {
                if let Ok(stream) = open_stream(&Peer { address: endpoint.clone(), ..peer.clone() }) { found = Some((stream, endpoint)); break; }
            }
            found.ok_or(first)?
        }
    };
    {
        let mut inner = runtime.inner.lock().map_err(err)?;
        let current = inner.credentials.peer.as_mut().filter(|current| current.secret == peer.secret).ok_or("SYNC_AUTH: 配对状态已变化")?;
        if current.address != endpoint { current.address = endpoint; save_credentials(runtime, &inner)?; }
    }
    stream.sock.set_read_timeout(Some(Duration::from_millis(100))).map_err(err)?;
    stream.sock.set_write_timeout(Some(Duration::from_secs(5))).map_err(err)?;
    let (id, commands) = install_connection(runtime, &peer.secret, &stream.sock, Some(epoch))?;
    let runtime = runtime.clone(); let app = app.clone();
    std::thread::spawn(move || {
        let _ = connection::client(&mut stream, commands, || connection_current(&runtime, &id, &peer.secret), || { let _ = app.emit("taskrail:sync-wake", ()); });
        // 意外断线唤醒控制器更新状态并按既有错误策略重试；主动关闭已经移除了代次。
        if remove_connection(&runtime, Some(&id)) { let _ = app.emit("taskrail:sync-wake", ()); }
    });
    Ok(())
}
#[tauri::command]
pub async fn sync_status(app: tauri::AppHandle, state: tauri::State<'_, SyncState>) -> Result<Value> {
    let runtime = runtime(&app, &state)?;
    let paired = runtime.inner.lock().map_err(err)?.credentials.peer.is_some();
    if paired && !cfg!(target_os = "android") { start(&app, &runtime)?; }
    let inner = runtime.inner.lock().map_err(err)?;
    Ok(json!({"paired": paired, "session": inner.credentials.peer.as_ref().map(|peer| storage::fingerprint(peer.secret.as_bytes())), "address": inner.credentials.peer.as_ref().map(|peer| &peer.address), "pending": inner.pending.as_ref().map(|peer| &peer.id), "listening": inner.port.is_some()}))
}
#[tauri::command]
pub async fn sync_offer(app: tauri::AppHandle, state: tauri::State<'_, SyncState>) -> Result<Offer> {
    let runtime = runtime(&app, &state)?; start(&app, &runtime)?;
    let mut inner = runtime.inner.lock().map_err(err)?;
    if inner.credentials.peer.is_some() { return Err("已有配对设备，请先解除配对".into()); }
    let addresses = local_addresses(inner.port.unwrap());
    let offer = Offer { version: 1, address: addresses[0].clone(), addresses, certificate: inner.credentials.certificate.clone(), token: random(), expires: now() + 300 };
    inner.offer = Some(offer.clone()); inner.pending = None; Ok(offer)
}
#[tauri::command]
pub async fn sync_approve(app: tauri::AppHandle, state: tauri::State<'_, SyncState>, accept: bool) -> Result<()> {
    let runtime = runtime(&app, &state)?; let mut inner = runtime.inner.lock().map_err(err)?;
    let pending = inner.pending.take().ok_or("没有待处理配对请求")?;
    if accept {
        if inner.offer.as_ref().is_none_or(|offer| offer.expires < now()) { return Err("配对已过期".into()); }
        inner.credentials.peer = Some(pending); save_credentials(&runtime, &inner)?;
    }
    inner.offer = None; Ok(())
}
#[tauri::command]
pub async fn sync_pair(app: tauri::AppHandle, state: tauri::State<'_, SyncState>, offer: Offer) -> Result<bool> {
    if offer.version != 1 || offer.expires < now() || offer.certificate.len() > 8192 || offer.token.len() != 64 { return Err("配对二维码无效或已过期".into()); }
    address(&offer.address)?;
    let runtime = runtime(&app, &state)?;
    let (id, secret) = { let inner = runtime.inner.lock().map_err(err)?; if inner.credentials.peer.is_some() { return Err("请先解除已有配对".into()); } (inner.credentials.id.clone(), inner.credentials.secret.clone()) };
    let mut peer = Peer { id: id.clone(), secret: secret.clone(), address: offer.address, certificate: offer.certificate };
    let target = peer.clone();
    let (accepted, address) = tauri::async_runtime::spawn_blocking(move || connect_available(&target, &json!({"protocol":1,"action":"pair","id":id,"secret":secret,"token":offer.token}))).await.map_err(err)??;
    peer.address = address;
    if accepted == true { let mut inner = runtime.inner.lock().map_err(err)?; inner.credentials.peer = Some(peer); save_credentials(&runtime, &inner)?; return Ok(true); }
    Ok(false)
}
#[tauri::command]
pub async fn sync_unpair(app: tauri::AppHandle, state: tauri::State<'_, SyncState>) -> Result<()> {
    let runtime = runtime(&app, &state)?; let mut inner = runtime.inner.lock().map_err(err)?;
    inner.credentials.peer = None; inner.credentials.secret = random(); inner.pending = None; inner.offer = None;
    runtime.connection_epoch.fetch_add(1, Ordering::SeqCst); remove_connection(&runtime, None);
    save_credentials(&runtime, &inner)
}
#[tauri::command]
pub async fn sync_address(app: tauri::AppHandle, state: tauri::State<'_, SyncState>, address: String) -> Result<()> {
    self::address(&address)?; let runtime = runtime(&app, &state)?; let mut inner = runtime.inner.lock().map_err(err)?;
    inner.credentials.peer.as_mut().ok_or("设备尚未配对")?.address = address;
    runtime.connection_epoch.fetch_add(1, Ordering::SeqCst); remove_connection(&runtime, None);
    save_credentials(&runtime, &inner)
}
#[tauri::command]
pub async fn sync_exchange(app: tauri::AppHandle, state: tauri::State<'_, SyncState>, envelope: Value) -> Result<Value> {
    let runtime = runtime(&app, &state)?;
    tauri::async_runtime::spawn_blocking(move || {
        // 建连只由前台 probe 发起；退到后台后尚在生成信封的旧任务不能重新打开连接。
        let (send, receive) = mpsc::sync_channel(1);
        {
            let live = runtime.connection.lock().map_err(err)?;
            live.as_ref().ok_or("同步连接已关闭")?.sender.try_send(connection::Command::Exchange(envelope, send)).map_err(|_| "同步连接忙或已关闭")?;
        }
        receive.recv_timeout(Duration::from_secs(35)).map_err(|_| "同步连接超时，内容保留，稍后重试".to_string())?
    }).await.map_err(err)?
}
#[tauri::command]
pub async fn sync_probe(app: tauri::AppHandle, state: tauri::State<'_, SyncState>) -> Result<()> {
    let runtime = runtime(&app, &state)?;
    let epoch = runtime.connection_epoch.load(Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || ensure_connection(&app, &runtime, epoch)).await.map_err(err)?
}
#[tauri::command]
pub async fn sync_notify(app: tauri::AppHandle, state: tauri::State<'_, SyncState>) -> Result<()> {
    let runtime = runtime(&app, &state)?;
    if let Some(live) = runtime.connection.lock().map_err(err)?.as_ref() {
        // 多次输入可合并为一个通知；队列已满代表已有工作待发，不丢弃正文版本。
        let _ = live.sender.try_send(connection::Command::Wake);
    }
    Ok(())
}
#[tauri::command]
pub fn sync_disconnect(app: tauri::AppHandle, state: tauri::State<'_, SyncState>) -> Result<()> {
    let runtime = runtime(&app, &state)?;
    runtime.connection_epoch.fetch_add(1, Ordering::SeqCst); remove_connection(&runtime, None);
    Ok(())
}
#[tauri::command]
pub async fn sync_respond(app: tauri::AppHandle, state: tauri::State<'_, SyncState>, id: String, envelope: Option<Value>, error: Option<String>) -> Result<()> {
    let runtime = runtime(&app, &state)?;
    if let Some(sender) = runtime.responses.lock().map_err(err)?.remove(&id) {
        let _ = sender.send(match (envelope, error) { (_, Some(error)) => Err(error), (Some(value), None) => Ok(value), _ => Err("同步响应缺失".into()) });
    }
    Ok(())
}
#[tauri::command]
pub async fn sync_load_state(app: tauri::AppHandle) -> Result<Option<Value>> {
    let path = app.path().app_data_dir().map_err(err)?.join("sync/documents.json");
    tauri::async_runtime::spawn_blocking(move || storage::load_json(&path).map_err(|e| e.message)).await.map_err(err)?
}
#[tauri::command]
pub async fn sync_save_state(app: tauri::AppHandle, value: Value) -> Result<()> {
    let path = app.path().app_data_dir().map_err(err)?.join("sync/documents.json");
    tauri::async_runtime::spawn_blocking(move || save_documents(&path, &value)).await.map_err(err)?
}
/** 撤销或更换配对时先保存旧记录，待接收正文和冲突对端版本不能随映射清除而消失。 */
fn save_documents(path: &std::path::Path, value: &Value) -> Result<()> {
    if let Some(previous) = storage::load_json(path).map_err(|e| e.message)? {
        if previous["pairing"] != value["pairing"] && previous["records"].as_object().is_some_and(|records| !records.is_empty()) {
            let archive = path.with_file_name(format!("detached-{}.json", random()));
            storage::save_json(&archive, &previous).map_err(|e| e.message)?;
        }
    }
    storage::save_json(path, value).map_err(|e| e.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detached_pairing_preserves_pending_and_conflicting_versions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("documents.json");
        let previous = json!({"version":1,"pairing":"old","records":{"pending":{"text":"尚未接收的正文"}}});
        save_documents(&path, &previous).unwrap();
        save_documents(&path, &json!({"version":1,"records":{}})).unwrap();
        let archive = std::fs::read_dir(directory.path()).unwrap().flatten().find(|entry| entry.file_name().to_string_lossy().starts_with("detached-")).unwrap();
        assert_eq!(storage::load_json(&archive.path()).unwrap(), Some(previous));
        assert_eq!(storage::load_json(&path).unwrap().unwrap()["records"], json!({}));
    }
    #[test]
    fn frame_limits_and_truncation_are_rejected() {
        assert!(read_frame(&mut std::io::Cursor::new(((LIMIT + 1) as u32).to_be_bytes())).is_err());
        assert!(read_frame(&mut std::io::Cursor::new(vec![0,0,0,4,b'{'])).is_err());
        let mut bytes = vec![]; write_frame(&mut bytes, &json!({"protocol":1})).unwrap();
        assert_eq!(read_frame(&mut std::io::Cursor::new(bytes)).unwrap()["protocol"], 1);
    }
    #[test]
    fn only_local_addresses_are_allowed() {
        assert!(address("192.168.1.2:8000").is_ok()); assert!(address("8.8.8.8:443").is_err()); assert!(address("example.com:443").is_err());
    }
    #[test]
    fn tls_round_trip_verifies_the_paired_certificate() {
        let certificate = rcgen::generate_simple_self_signed(vec!["taskrail.local".into()]).unwrap();
        let config = ServerConfig::builder().with_no_client_auth().with_single_cert(
            vec![certificate.cert.der().clone()], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(certificate.key_pair.serialize_der()))).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let mut stream = StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), socket);
            let request = read_frame(&mut stream).unwrap();
            assert_eq!(request["envelope"]["documents"][0]["text"], "中文待办");
            write_frame(&mut stream, &json!({"ok":{"protocol":1,"received":true}})).unwrap();
        });
        let peer = Peer { id: "test".into(), secret: "secret".into(), address: endpoint, certificate: certificate.cert.der().to_vec() };
        let response = connect(&peer, &json!({"protocol":1,"envelope":{"documents":[{"text":"中文待办"}]}})).unwrap();
        assert_eq!(response["received"], true); server.join().unwrap();
    }
    #[test]
    fn tls_stream_reuses_connection_after_idle_and_delivers_both_directions() {
        use std::sync::atomic::AtomicBool;
        let certificate = rcgen::generate_simple_self_signed(vec!["taskrail.local".into()]).unwrap();
        let config = ServerConfig::builder().with_no_client_auth().with_single_cert(
            vec![certificate.cert.der().clone()], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(certificate.key_pair.serialize_der()))).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let peer = Peer { id: random(), secret: random(), address: listener.local_addr().unwrap().to_string(), certificate: certificate.cert.der().to_vec() };
        let expected = peer.clone(); let alive = Arc::new(AtomicBool::new(true));
        let (desktop_send, desktop_receive) = mpsc::sync_channel(8);
        let running = alive.clone();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            socket.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut stream = StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), socket);
            let request = read_frame(&mut stream).unwrap();
            assert_eq!(request["id"], expected.id); assert_eq!(request["secret"], expected.secret);
            assert_eq!(request["action"], "stream");
            write_frame(&mut stream, &json!({"ok":{"stream":1}})).unwrap();
            stream.sock.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
            connection::server(&mut stream, desktop_receive, || running.load(Ordering::SeqCst), Ok)
        });
        let mut stream = open_stream(&peer).unwrap();
        stream.sock.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        let (phone_send, phone_receive) = mpsc::sync_channel(8);
        let (wake_send, wake_receive) = mpsc::sync_channel(8);
        let running = alive.clone();
        let client = std::thread::spawn(move || connection::client(&mut stream, phone_receive, || running.load(Ordering::SeqCst), || { let _ = wake_send.send(()); }));
        // 跨过多次 socket 读超时后，TLS 状态和同一连接仍须可用。
        std::thread::sleep(Duration::from_millis(150));
        desktop_send.send(connection::Command::Wake).unwrap();
        wake_receive.recv_timeout(Duration::from_secs(2)).unwrap();
        for text in ["手机正文", "电脑响应后的确认"] {
            let (send, receive) = mpsc::sync_channel(1);
            phone_send.send(connection::Command::Exchange(json!({"text":text}), send)).unwrap();
            assert_eq!(receive.recv_timeout(Duration::from_secs(2)).unwrap().unwrap()["text"], text);
        }
        alive.store(false, Ordering::SeqCst);
        let _ = client.join().unwrap(); let _ = server.join().unwrap();
    }
    #[test]
    fn revoked_and_unrecognized_devices_cannot_authenticate() {
        let peer = Peer { id: random(), secret: random(), address: String::new(), certificate: vec![] };
        let request = json!({"id":peer.id,"secret":peer.secret});
        let mut inner = Inner { credentials: Credentials { id: random(), secret: random(), certificate: vec![], key: vec![], peer: Some(peer) }, offer: None, pending: None, port: None, daemon: None };
        assert!(authenticated(&inner, &request));
        assert!(!authenticated(&inner, &json!({"id":request["id"],"secret":"wrong"})));
        inner.credentials.peer = None; assert!(!authenticated(&inner, &request));
    }
    #[test]
    fn replacing_connection_and_cancelling_connect_preserve_generation_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let peer = Peer { id: random(), secret: random(), address: String::new(), certificate: vec![] };
        let runtime = Runtime {
            inner: Mutex::new(Inner { credentials: Credentials { id: random(), secret: random(), certificate: vec![], key: vec![], peer: Some(peer.clone()) }, offer: None, pending: None, port: None, daemon: None }),
            directory: directory.path().into(), responses: Mutex::new(HashMap::new()), connection: Mutex::new(None), connection_start: Mutex::new(()), connection_epoch: AtomicUsize::new(0),
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut first_peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        first_peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let (first, _) = listener.accept().unwrap();
        let (old_id, _) = install_connection(&runtime, &peer.secret, &first, Some(0)).unwrap();
        let _second_peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (second, _) = listener.accept().unwrap();
        let (new_id, _) = install_connection(&runtime, &peer.secret, &second, Some(0)).unwrap();
        assert_eq!(first_peer.read(&mut [0; 1]).unwrap(), 0);
        assert!(!remove_connection(&runtime, Some(&old_id)));
        assert!(connection_current(&runtime, &new_id, &peer.secret));
        runtime.connection_epoch.fetch_add(1, Ordering::SeqCst);
        remove_connection(&runtime, None);
        assert!(install_connection(&runtime, &peer.secret, &second, Some(0)).is_err());
        assert!(!connection_current(&runtime, &new_id, &peer.secret));
        runtime.inner.lock().unwrap().credentials.peer = None;
        assert!(install_connection(&runtime, &peer.secret, &second, Some(1)).is_err());
    }
}
