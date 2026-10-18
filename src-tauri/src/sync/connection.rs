//! 文件职责：在已经认证的 TLS 流上承载文档交换、变更通知与心跳。
//! 定义范围：帧解码、连接命令与连接循环；不负责配对、发现或文档合并。
use serde_json::{json, Value};
use std::{io::{Read, Write, ErrorKind}, sync::mpsc, time::{Duration, Instant}};

type Result<T> = std::result::Result<T, String>;

/**
 * 结构职责：把前端交换与本机变更提交给唯一持有 TLS 流的线程。
 * 字段说明：Exchange 携带正文信封及单次响应通道，Wake 仅提示对端发起交换。
 * 约束条件：凭证不进入连接帧；连接认证由调用方在启动循环之前完成。
 */
pub enum Command { Exchange(Value, mpsc::SyncSender<Result<Value>>), Wake }

/** 读取超时只表示本轮没有新字节，不能丢掉已读的长度前缀或正文片段。 */
#[derive(Default)]
struct Frames { bytes: Vec<u8> }
impl Frames {
    fn take(&mut self) -> Result<Option<Value>> {
        if self.bytes.len() < 4 { return Ok(None); }
        let length = u32::from_be_bytes(self.bytes[..4].try_into().unwrap()) as usize;
        if length == 0 || length > super::LIMIT { return Err("SYNC_LIMIT: 同步消息过大".into()); }
        if self.bytes.len() < length + 4 { return Ok(None); }
        let value = serde_json::from_slice(&self.bytes[4..length + 4]).map_err(super::err)?;
        self.bytes.drain(..length + 4);
        Ok(Some(value))
    }
    fn poll(&mut self, stream: &mut impl Read) -> Result<Option<Value>> {
        if let Some(value) = self.take()? { return Ok(Some(value)); }
        let mut bytes = [0; 16384];
        match stream.read(&mut bytes) {
            Ok(0) => Err("同步连接已关闭，内容保留，稍后重试".into()),
            Ok(length) => { self.bytes.extend_from_slice(&bytes[..length]); self.take() }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => Ok(None),
            Err(error) => Err(super::err(error)),
        }
    }
}

/**
 * 函数职责：在手机侧复用同一条流发送交换请求并接收电脑变更通知。
 * 输入说明：stream 已通过固定证书和配对凭证认证，读超时须为短间隔；current 校验配对仍有效。
 * 输出说明：断线、超时或配对失效时退出，所有待处理请求返回错误。
 * 实现思路：单线程拥有流，保留半帧，交替处理有界命令队列与网络消息，并定期发送心跳。
 */
pub fn client(stream: &mut (impl Read + Write), commands: mpsc::Receiver<Command>, current: impl Fn() -> bool, wake: impl Fn()) -> Result<()> {
    let mut frames = Frames::default();
    let mut pending: Option<(u64, mpsc::SyncSender<Result<Value>>, Instant)> = None;
    let mut next = 0u64;
    let mut heartbeat = Instant::now(); let mut received = Instant::now();
    let result = (|| {
        while current() {
            // 每轮有界处理，避免持续提交命令阻止读取响应与心跳。
            for command in commands.try_iter().take(8) {
                match command {
                    Command::Exchange(envelope, response) => {
                        if pending.is_some() { let _ = response.send(Err("同步交换正在进行".into())); continue; }
                        next = next.checked_add(1).ok_or("同步请求序号超出范围")?;
                        pending = Some((next, response, Instant::now()));
                        super::write_frame(stream, &json!({"type":"exchange","id":next,"envelope":envelope}))?;
                    }
                    Command::Wake => {}
                }
            }
            if heartbeat.elapsed() >= Duration::from_secs(10) {
                super::write_frame(stream, &json!({"type":"ping"}))?; heartbeat = Instant::now();
            }
            if received.elapsed() > Duration::from_secs(35) || pending.as_ref().is_some_and(|(_, _, start)| start.elapsed() > Duration::from_secs(30)) {
                return Err("同步连接超时，内容保留，稍后重试".into());
            }
            let Some(message) = frames.poll(stream)? else { continue; };
            if !current() { return Err("SYNC_AUTH: 配对状态已变化".into()); }
            received = Instant::now();
            match message["type"].as_str() {
                Some("wake") => wake(),
                Some("pong") => {},
                Some("response") => {
                    let expected = pending.as_ref().ok_or("SYNC_INVALID: 收到未知同步响应")?.0;
                    if message["id"].as_u64() != Some(expected) { return Err("SYNC_INVALID: 同步响应序号不匹配".into()); }
                    let (_, response, _) = pending.take().unwrap();
                    let value = match message["error"].as_str() {
                        Some(error) => Err(error.into()),
                        None => message.get("ok").cloned().ok_or_else(|| "SYNC_INVALID: 同步响应缺失".into()),
                    };
                    let _ = response.send(value);
                }
                _ => return Err("SYNC_PROTOCOL: 未知连接消息".into()),
            }
        }
        Err("SYNC_AUTH: 同步连接已停用".into())
    })();
    if let Some((_, response, _)) = pending { let _ = response.send(result.clone().and_then(|_| Err("同步连接已关闭".into()))); }
    result
}

/**
 * 函数职责：在电脑侧推送变更通知并回复同一条流上的文档交换。
 * 输入说明：exchange 复用已认证的前端文档协调器，current 每轮检查配对与连接代次。
 * 输出说明：连接失效或网络错误时退出；文档交换失败只回复该次错误。
 * 实现思路：唯一线程交替读取消息与通知命令，文档交换串行，心跳不进入文档处理器。
 */
pub fn server(stream: &mut (impl Read + Write), commands: mpsc::Receiver<Command>, current: impl Fn() -> bool, exchange: impl Fn(Value) -> Result<Value>) -> Result<()> {
    let mut frames = Frames::default(); let mut received = Instant::now();
    while current() {
        let mut notify = false;
        for command in commands.try_iter().take(8) {
            match command {
                Command::Wake => notify = true,
                Command::Exchange(_, response) => { let _ = response.send(Err("电脑通过变更通知触发对端交换".into())); }
            }
        }
        if notify { super::write_frame(stream, &json!({"type":"wake"}))?; }
        if received.elapsed() > Duration::from_secs(35) { return Err("同步连接心跳超时".into()); }
        let Some(message) = frames.poll(stream)? else { continue; };
        if !current() { return Err("SYNC_AUTH: 配对状态已变化".into()); }
        received = Instant::now();
        match message["type"].as_str() {
            Some("ping") => super::write_frame(stream, &json!({"type":"pong"}))?,
            Some("exchange") => {
                let id = message["id"].as_u64().ok_or("SYNC_INVALID: 同步请求序号无效")?;
                let result = exchange(message["envelope"].clone());
                // 文档处理可能等待前端；回复前再次确认连接与配对未被撤销。
                if !current() { return Err("SYNC_AUTH: 配对状态已变化".into()); }
                let response = match result { Ok(value) => json!({"type":"response","id":id,"ok":value}), Err(error) => json!({"type":"response","id":id,"error":error}) };
                super::write_frame(stream, &response)?;
            }
            _ => return Err("SYNC_PROTOCOL: 未知连接消息".into()),
        }
    }
    Err("SYNC_AUTH: 同步连接已停用".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{net::{TcpListener, TcpStream}, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};

    #[test]
    fn partial_frame_survives_read_timeout_and_preserves_next_frame() {
        let mut first = vec![]; super::super::write_frame(&mut first, &json!({"text":"中文正文"})).unwrap();
        let mut second = vec![]; super::super::write_frame(&mut second, &json!({"type":"ping"})).unwrap();
        let mut frames = Frames::default();
        frames.bytes.extend_from_slice(&first[..2]);
        struct Timeout;
        impl Read for Timeout { fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> { Err(ErrorKind::TimedOut.into()) } }
        assert!(frames.poll(&mut Timeout).unwrap().is_none());
        frames.bytes.extend_from_slice(&first[2..first.len() - 1]);
        assert!(frames.poll(&mut Timeout).unwrap().is_none());
        frames.bytes.extend_from_slice(&first[first.len() - 1..]); frames.bytes.extend_from_slice(&second);
        assert_eq!(frames.take().unwrap().unwrap()["text"], "中文正文");
        assert_eq!(frames.take().unwrap().unwrap()["type"], "ping");
        assert!(frames.bytes.is_empty());
        frames.bytes = ((super::super::LIMIT + 1) as u32).to_be_bytes().to_vec();
        assert!(frames.take().is_err());
    }

    #[test]
    fn same_connection_delivers_desktop_wake_and_multiple_mobile_exchanges() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut phone = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut desktop, _) = listener.accept().unwrap();
        phone.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        desktop.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        let alive = Arc::new(AtomicBool::new(true));
        let (phone_send, phone_receive) = mpsc::sync_channel(8);
        let (desktop_send, desktop_receive) = mpsc::sync_channel(8);
        let (wake_send, wake_receive) = mpsc::sync_channel(8);
        let running = alive.clone();
        let phone_thread = std::thread::spawn(move || client(&mut phone, phone_receive, || running.load(Ordering::SeqCst), || { let _ = wake_send.send(()); }));
        let running = alive.clone();
        let desktop_thread = std::thread::spawn(move || server(&mut desktop, desktop_receive, || running.load(Ordering::SeqCst), |value| {
            if value["fail"] == true { return Err("SYNC_SAVE: 保存失败".into()); }
            Ok(json!({"received":value}))
        }));
        desktop_send.send(Command::Wake).unwrap();
        wake_receive.recv_timeout(Duration::from_secs(2)).expect("电脑修改应通过原连接主动唤醒手机");
        let (send, receive) = mpsc::sync_channel(1);
        phone_send.send(Command::Exchange(json!({"fail":true}), send)).unwrap();
        assert_eq!(receive.recv_timeout(Duration::from_secs(2)).unwrap().unwrap_err(), "SYNC_SAVE: 保存失败");
        for text in ["手机第一次修改", "手机第二次修改"] {
            let (send, receive) = mpsc::sync_channel(1);
            phone_send.send(Command::Exchange(json!({"text":text}), send)).unwrap();
            assert_eq!(receive.recv_timeout(Duration::from_secs(2)).unwrap().unwrap()["received"]["text"], text);
        }
        alive.store(false, Ordering::SeqCst);
        let _ = phone_thread.join().unwrap(); let _ = desktop_thread.join().unwrap();
    }

    #[test]
    fn disconnected_stream_rejects_pending_exchange() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut phone = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut desktop, _) = listener.accept().unwrap();
        phone.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        let server = std::thread::spawn(move || { let _ = super::super::read_frame(&mut desktop).unwrap(); });
        let (send, commands) = mpsc::sync_channel(8);
        let (response, result) = mpsc::sync_channel(1);
        send.send(Command::Exchange(json!({"text":"尚未确认的正文"}), response)).unwrap();
        assert!(client(&mut phone, commands, || true, || {}).is_err());
        assert!(result.recv_timeout(Duration::from_secs(1)).unwrap().is_err());
        server.join().unwrap();
    }
}
