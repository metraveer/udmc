use std::io;
use std::net::IpAddr;
use std::pin::Pin;
use std::task::{ready, Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

use crate::native_error::{NativeError, NativeResult};

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_FRAME: usize = 64 * 1024;
const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[tauri::command]
pub async fn rcon_execute(
    host: String,
    port: u16,
    password: String,
    command: String,
) -> NativeResult<String> {
    execute(&host, port, &password, &command, TIMEOUT).await
}

async fn execute(
    host: &str,
    port: u16,
    password: &str,
    command: &str,
    timeout: Duration,
) -> NativeResult<String> {
    let host = validate_host(host)?;
    let command = command.trim().trim_start_matches('/');
    if port == 0 {
        return Err(NativeError::new(
            "RCON_PORT_INVALID",
            "RCON port must be between 1 and 65535.",
        ));
    }
    if password.is_empty() || password.len() > 1024 || password.contains('\0') {
        return Err(NativeError::new(
            "RCON_PASSWORD_INVALID",
            "Enter an RCON password up to 1024 bytes without null characters.",
        ));
    }
    if command.is_empty()
        || command.chars().count() > 512
        || command.len() > 1413
        || command.contains(['\r', '\n', '\0'])
    {
        return Err(NativeError::new(
            "RCON_COMMAND_INVALID",
            "Enter one command up to 512 characters (1413 bytes).",
        ));
    }

    let mut sent = false;
    let result = tokio::time::timeout(timeout, async {
        let socket = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|_| {
                NativeError::new(
                    "RCON_CONNECT_FAILED",
                    "Could not connect to RCON. Check the address, port, and server availability.",
                )
            })?;
        let mut connection = ::rcon::Connection::handshake(CheckedStream::new(socket), password)
            .await
            .map_err(|error| match error {
                ::rcon::Error::Auth => {
                    NativeError::new("RCON_AUTH_FAILED", "The server rejected the RCON password.")
                }
                _ => NativeError::new(
                    "RCON_HANDSHAKE_FAILED",
                    "The server did not confirm RCON access or returned a malformed response.",
                ),
            })?;
        sent = true;
        connection.cmd(command).await.map_err(|_| {
            NativeError::new(
                "RCON_RESPONSE_FAILED",
                "Could not read the complete RCON response: the connection closed, the response was malformed, or it exceeded 4 MiB.",
            )
        })
    }).await;
    let result = result.unwrap_or_else(|_| {
        Err(NativeError::new(
            "RCON_TIMEOUT",
            "The RCON server did not respond in time.",
        ))
    });
    result.map_err(|error| if sent { error.outcome_unknown() } else { error })
}

fn validate_host(value: &str) -> NativeResult<String> {
    let host = value.trim();
    let unbracketed = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(address) = unbracketed.parse::<IpAddr>() {
        return Ok(address.to_string());
    }
    if !host.is_empty()
        && !host.contains([':', '/', '\\', '@', '?', '#', '%', '[', ']'])
        && !host.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        if let Ok(url::Host::Domain(domain)) = url::Host::parse(host) {
            return Ok(domain);
        }
    }
    Err(NativeError::new(
        "RCON_HOST_INVALID",
        "Enter only an RCON domain or IP address without a protocol or port.",
    ))
}

// Validate each frame before the protocol library sees its size. This bounds its
// allocations and the aggregate multipart response, including authentication.
struct CheckedStream<T> {
    inner: T,
    frame: Vec<u8>,
    filled: usize,
    delivered: usize,
    remaining: usize,
}

impl<T> CheckedStream<T> {
    fn new(inner: T) -> Self {
        Self {
            inner,
            frame: vec![0; 4],
            filled: 0,
            delivered: 0,
            remaining: MAX_RESPONSE,
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for CheckedStream<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        while this.filled < this.frame.len() {
            let mut buffer = ReadBuf::new(&mut this.frame[this.filled..]);
            ready!(Pin::new(&mut this.inner).poll_read(cx, &mut buffer))?;
            if buffer.filled().is_empty() {
                return Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()));
            }
            this.filled += buffer.filled().len();
            if this.filled == 4 && this.frame.len() == 4 {
                let length = i32::from_le_bytes(this.frame[..4].try_into().unwrap());
                if !(10..=MAX_FRAME as i32).contains(&length)
                    || length as usize + 4 > this.remaining
                {
                    return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
                }
                this.remaining -= length as usize + 4;
                this.frame.resize(length as usize + 4, 0);
            }
        }
        if this.frame[this.frame.len() - 2..] != [0, 0] {
            return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
        }
        let end = (this.delivered + output.remaining()).min(this.frame.len());
        output.put_slice(&this.frame[this.delivered..end]);
        this.delivered = end;
        if end == this.frame.len() {
            this.frame.truncate(4);
            this.filled = 0;
            this.delivered = 0;
        }
        Poll::Ready(Ok(()))
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for CheckedStream<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream as Socket};
    use std::thread;
    use tokio::io::AsyncReadExt;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn packet(id: i32, kind: i32, text: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(10 + text.len() as i32).to_le_bytes());
        bytes.extend_from_slice(&id.to_le_bytes());
        bytes.extend_from_slice(&kind.to_le_bytes());
        bytes.extend_from_slice(text.as_bytes());
        bytes.extend_from_slice(&[0, 0]);
        bytes
    }

    fn read(socket: &mut Socket) -> (i32, i32, String) {
        let mut size = [0; 4];
        socket.read_exact(&mut size).unwrap();
        let length = i32::from_le_bytes(size);
        assert!((10..2048).contains(&length));
        let mut bytes = vec![0; length as usize];
        socket.read_exact(&mut bytes).unwrap();
        (
            i32::from_le_bytes(bytes[..4].try_into().unwrap()),
            i32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            String::from_utf8(bytes[8..bytes.len() - 2].to_vec()).unwrap(),
        )
    }

    fn mock(handler: impl FnOnce(Socket) + Send + 'static) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let task = thread::spawn(move || {
            let start = std::time::Instant::now();
            let socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && start.elapsed() < Duration::from_secs(5) =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("mock accept: {error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            handler(socket);
        });
        (port, task)
    }

    fn authenticate(socket: &mut Socket) {
        let (id, kind, secret) = read(socket);
        assert_eq!(kind, 3);
        assert_eq!(secret, " secret ");
        socket.write_all(&packet(id, 2, "")).unwrap();
    }

    #[test]
    fn exact_password_delayed_multipart_and_unicode() {
        let (port, server) = mock(|mut socket| {
            authenticate(&mut socket);
            let (id, kind, command) = read(&mut socket);
            assert_eq!((kind, command.as_str()), (2, "list"));
            let (end, _, marker) = read(&mut socket);
            assert!(marker.is_empty());
            socket.write_all(&packet(id, 0, "Игроки: ")).unwrap();
            thread::sleep(Duration::from_millis(260));
            for byte in packet(id, 0, "Alex, Steve") {
                socket.write_all(&[byte]).unwrap();
            }
            socket.write_all(&packet(end, 0, "end")).unwrap();
        });
        let result = runtime().block_on(execute("127.0.0.1", port, " secret ", " /list ", TIMEOUT));
        server.join().unwrap();
        assert_eq!(result.unwrap(), "Игроки: Alex, Steve");
    }

    #[test]
    fn authentication_failure_never_sends_command() {
        let (port, server) = mock(|mut socket| {
            read(&mut socket);
            socket.write_all(&packet(-1, 2, "")).unwrap();
            assert_eq!(socket.read(&mut [0; 1]).unwrap(), 0);
        });
        let result = runtime().block_on(execute("127.0.0.1", port, "wrong", "stop", TIMEOUT));
        server.join().unwrap();
        assert_eq!(result.unwrap_err().code, "RCON_AUTH_FAILED");
    }

    #[test]
    fn empty_command_response_is_successful() {
        let (port, server) = mock(|mut socket| {
            authenticate(&mut socket);
            let (id, _, _) = read(&mut socket);
            let (end, _, _) = read(&mut socket);
            socket.write_all(&packet(id, 0, "")).unwrap();
            socket.write_all(&packet(end, 0, "")).unwrap();
        });
        let result = runtime().block_on(execute("127.0.0.1", port, " secret ", "list", TIMEOUT));
        server.join().unwrap();
        assert_eq!(result.unwrap(), "");
    }

    #[test]
    fn stalled_response_times_out_without_retrying_command() {
        let (port, server) = mock(|mut socket| {
            authenticate(&mut socket);
            read(&mut socket);
            read(&mut socket);
            thread::sleep(Duration::from_millis(350));
            assert_eq!(socket.read(&mut [0; 1]).unwrap(), 0);
        });
        let result = runtime().block_on(execute(
            "127.0.0.1",
            port,
            " secret ",
            "stop",
            Duration::from_millis(200),
        ));
        server.join().unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.code, "RCON_TIMEOUT");
        assert!(error.outcome_unknown);
    }

    #[test]
    fn partial_response_is_not_reported_as_success() {
        let (port, server) = mock(|mut socket| {
            authenticate(&mut socket);
            let (id, _, _) = read(&mut socket);
            read(&mut socket);
            socket.write_all(&packet(id, 0, "incomplete")).unwrap();
        });
        let result = runtime().block_on(execute("127.0.0.1", port, " secret ", "list", TIMEOUT));
        server.join().unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.code, "RCON_RESPONSE_FAILED");
        assert!(error.outcome_unknown);
    }

    #[test]
    fn malformed_frames_are_rejected_before_protocol_allocations() {
        let mut bad_trailer = packet(1, 2, "");
        *bad_trailer.last_mut().unwrap() = 1;
        for bytes in [
            (-1_i32).to_le_bytes().to_vec(),
            9_i32.to_le_bytes().to_vec(),
            i32::MAX.to_le_bytes().to_vec(),
            bad_trailer,
            vec![10, 0, 0],
        ] {
            let result = runtime().block_on(async {
                CheckedStream::new(bytes.as_slice())
                    .read_to_end(&mut Vec::new())
                    .await
            });
            assert!(result.is_err());
        }
    }

    #[test]
    fn aggregate_response_budget_is_enforced() {
        let bytes = [packet(1, 0, "hello"), packet(2, 0, "world")].concat();
        let result = runtime().block_on(async {
            let mut stream = CheckedStream::new(bytes.as_slice());
            stream.remaining = 20;
            let mut first = [0; 19];
            stream.read_exact(&mut first).await.unwrap();
            stream.read_u8().await
        });
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn addresses_support_ipv6_but_reject_urls_ports_and_credentials() {
        for host in ["mc.example.com", "127.0.0.1", "::1", "[::1]"] {
            assert!(validate_host(host).is_ok());
        }
        assert_eq!(validate_host("[::1]").unwrap(), "::1");
        for host in [
            "",
            "https://mc.test",
            "mc.test:25575",
            "user@mc.test",
            "mc.test/a",
            "mc.test?x",
            "bad host",
        ] {
            assert!(validate_host(host).is_err(), "{host}");
        }
    }

    #[test]
    fn invalid_input_is_rejected_without_connecting() {
        for command in ["", "stop\nlist", "stop\0list"] {
            assert_eq!(
                runtime()
                    .block_on(execute("127.0.0.1", 1, "secret", command, TIMEOUT))
                    .unwrap_err()
                    .code,
                "RCON_COMMAND_INVALID"
            );
        }
        assert_eq!(
            runtime()
                .block_on(execute("127.0.0.1", 1, "sec\0ret", "list", TIMEOUT))
                .unwrap_err()
                .code,
            "RCON_PASSWORD_INVALID"
        );
    }
}
