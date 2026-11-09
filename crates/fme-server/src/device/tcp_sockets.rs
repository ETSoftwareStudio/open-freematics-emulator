//! Wi-Fi OBD-II adapters speak raw TCP.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::device_link::{DeviceLink, DeviceLinkError, LinkFuture, LinkOperation, latin1};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, Default)]
pub struct TcpSockets;

impl TcpSockets {
    #[tracing::instrument(name = "TcpSockets.open", skip_all, fields(host = host, port = port))]
    pub async fn open(&self, host: &str, port: u16) -> Result<TcpLink, DeviceLinkError> {
        let open_error = |error| DeviceLinkError::new(LinkOperation::Open, error);
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
            .await
            .map_err(|_| open_error(io::Error::new(io::ErrorKind::TimedOut, "connect timeout")))?
            .map_err(open_error)?;
        Ok(TcpLink {
            stream,
            ended: false,
        })
    }
}

/// An open socket; dropping it closes the connection.
#[derive(Debug)]
pub struct TcpLink {
    stream: TcpStream,
    ended: bool,
}

impl DeviceLink for TcpLink {
    fn write<'a>(&'a mut self, data: &'a [u8]) -> LinkFuture<'a, Result<(), DeviceLinkError>> {
        Box::pin(async move {
            self.stream
                .write_all(data)
                .await
                .map_err(|error| DeviceLinkError::new(LinkOperation::Write, error))
        })
    }

    fn next_chunk(&mut self) -> LinkFuture<'_, Option<Result<String, DeviceLinkError>>> {
        Box::pin(async move {
            if self.ended {
                return None;
            }
            let mut buffer = [0; 1024];
            let read = match self.stream.read(&mut buffer).await {
                Ok(0) => None,
                Ok(read) => return Some(Ok(latin1(&buffer[..read]))),
                Err(error) => Some(Err(DeviceLinkError::new(LinkOperation::Read, error))),
            };
            self.ended = true;
            read
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    // Real sockets, so wall-clock time: a paused clock would fire the connect timeout early.
    #[tokio::test]
    async fn exchanges_bytes_with_an_adapter_and_ends_when_it_hangs_up() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut link = TcpSockets.open("127.0.0.1", port).await.unwrap();
        let (mut adapter, _) = listener.accept().await.unwrap();

        link.write(b"ATZ\r").await.unwrap();
        let mut received = [0; 4];
        adapter.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"ATZ\r");

        adapter.write_all(b"ELM327 v1.5\r\xbb>").await.unwrap();
        let mut text = String::new();
        while text.len() < "ELM327 v1.5\r\u{bb}>".len() {
            text.push_str(&link.next_chunk().await.unwrap().unwrap());
        }
        assert_eq!(text, "ELM327 v1.5\r\u{bb}>");

        drop(adapter);
        assert!(link.next_chunk().await.is_none());
        assert!(link.next_chunk().await.is_none());
    }

    #[tokio::test]
    async fn fails_to_open_when_nothing_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = TcpSockets.open("127.0.0.1", port).await.unwrap_err();
        assert_eq!(error.operation, LinkOperation::Open);
    }
}
