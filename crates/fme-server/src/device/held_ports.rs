//! macOS (27.2) serves a Bluetooth SPP port once per pairing: after its first close, later opens
//! succeed but nothing ever answers until the adapter is paired again. So those ports stay open
//! for the server's lifetime, and each open leases the held port instead.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use tokio::sync::{mpsc, oneshot};

use super::device_link::{
    ChunkSender, Chunks, DeviceLink, DeviceLinkError, LinkFuture, LinkOperation,
};

enum Message {
    Attach(ChunkSender),
    Detach,
    Write(Vec<u8>, oneshot::Sender<Result<(), DeviceLinkError>>),
    Close(oneshot::Sender<()>),
}

#[derive(Debug)]
struct Entry {
    id: u64,
    inbox: mpsc::UnboundedSender<Message>,
    leased: bool,
}

/// The held ports by path. Each one is owned by a task that forwards its bytes to the current
/// lease, or drops them while there is none.
#[derive(Debug, Default)]
pub struct HeldPorts {
    entries: Mutex<HashMap<String, Entry>>,
    ids: AtomicU64,
    // Real opens run one at a time, so two can't both hold the same path.
    opening: tokio::sync::Mutex<()>,
}

fn busy() -> DeviceLinkError {
    DeviceLinkError::new(
        LinkOperation::Open,
        io::Error::new(io::ErrorKind::ResourceBusy, "port busy"),
    )
}

impl HeldPorts {
    fn entries(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Leases the port held at `path`, or holds the port `open` opens. Fails while it is leased.
    pub async fn lease<F>(
        self: &Arc<Self>,
        path: &str,
        open: impl FnOnce() -> F,
    ) -> Result<Lease, DeviceLinkError>
    where
        F: Future<Output = Result<Box<dyn DeviceLink>, DeviceLinkError>>,
    {
        let _opening = self.opening.lock().await;
        if let Some(lease) = self.reuse(path)? {
            return Ok(lease);
        }
        let link = open().await?;
        let id = self.ids.fetch_add(1, Ordering::Relaxed);
        let (inbox, messages) = mpsc::unbounded_channel();
        let (sender, chunks) = Chunks::channel();
        let entry = Entry {
            id,
            inbox: inbox.clone(),
            leased: true,
        };
        self.entries().insert(path.to_owned(), entry);
        let holder = Holder {
            ports: Arc::downgrade(self),
            path: path.to_owned(),
            id,
            lease: Some(sender),
        };
        tokio::spawn(holder.run(link, messages));
        Ok(self.make_lease(path, id, inbox, chunks, true))
    }

    fn reuse(self: &Arc<Self>, path: &str) -> Result<Option<Lease>, DeviceLinkError> {
        let mut entries = self.entries();
        let Some(entry) = entries.get_mut(path) else {
            return Ok(None);
        };
        if entry.leased {
            return Err(busy());
        }
        let (sender, chunks) = Chunks::channel();
        if entry.inbox.send(Message::Attach(sender)).is_err() {
            entries.remove(path);
            return Ok(None);
        }
        entry.leased = true;
        let (id, inbox) = (entry.id, entry.inbox.clone());
        drop(entries);
        Ok(Some(self.make_lease(path, id, inbox, chunks, false)))
    }

    fn make_lease(
        self: &Arc<Self>,
        path: &str,
        id: u64,
        inbox: mpsc::UnboundedSender<Message>,
        chunks: Chunks,
        fresh: bool,
    ) -> Lease {
        Lease {
            ports: Arc::downgrade(self),
            path: path.to_owned(),
            id,
            inbox,
            chunks,
            fresh,
        }
    }

    /// Closes every held port and waits until each is released.
    pub async fn close_all(&self) {
        let entries: Vec<Entry> = self.entries().drain().map(|(_, entry)| entry).collect();
        for entry in entries {
            let (ack, closed) = oneshot::channel();
            if entry.inbox.send(Message::Close(ack)).is_ok() && closed.await.is_err() {
                tracing::debug!("a held port ended before it confirmed closing");
            }
        }
    }
}

/// One open of a held port. Dropping or closing it detaches it; the port stays open.
pub struct Lease {
    ports: Weak<HeldPorts>,
    path: String,
    id: u64,
    inbox: mpsc::UnboundedSender<Message>,
    chunks: Chunks,
    fresh: bool,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lease")
            .field("fresh", &self.fresh)
            .finish_non_exhaustive()
    }
}

impl Lease {
    /// Whether this lease's open really opened the port, rather than reusing a held one.
    pub const fn is_fresh(&self) -> bool {
        self.fresh
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        // Detach goes out before the slot frees, so it can't land after the next lease attaches.
        if self.inbox.send(Message::Detach).is_err() {
            return;
        }
        if let Some(ports) = self.ports.upgrade()
            && let Some(entry) = ports.entries().get_mut(&self.path)
            && entry.id == self.id
        {
            entry.leased = false;
        }
    }
}

impl DeviceLink for Lease {
    fn write<'a>(&'a mut self, data: &'a [u8]) -> LinkFuture<'a, Result<(), DeviceLinkError>> {
        let (reply, answer) = oneshot::channel();
        let sent = self.inbox.send(Message::Write(data.to_vec(), reply));
        Box::pin(async move {
            let closed =
                || DeviceLinkError::new(LinkOperation::Write, io::ErrorKind::BrokenPipe.into());
            sent.map_err(|_| closed())?;
            answer.await.map_err(|_| closed())?
        })
    }

    fn next_chunk(&mut self) -> LinkFuture<'_, Option<Result<String, DeviceLinkError>>> {
        Box::pin(self.chunks.next())
    }
}

enum End {
    Read(Option<DeviceLinkError>),
    Write(
        DeviceLinkError,
        oneshot::Sender<Result<(), DeviceLinkError>>,
    ),
    Close(Option<oneshot::Sender<()>>),
}

struct Holder {
    ports: Weak<HeldPorts>,
    path: String,
    id: u64,
    lease: Option<ChunkSender>,
}

impl Holder {
    async fn run(
        mut self,
        mut link: Box<dyn DeviceLink>,
        mut messages: mpsc::UnboundedReceiver<Message>,
    ) {
        let end = loop {
            tokio::select! {
                chunk = link.next_chunk() => match chunk {
                    Some(Ok(text)) => {
                        if let Some(lease) = &self.lease
                            && lease.send(Ok(text)).is_err()
                        {
                            self.lease = None;
                        }
                    }
                    Some(Err(error)) => break End::Read(Some(error)),
                    None => break End::Read(None),
                },
                message = messages.recv() => match message {
                    Some(Message::Attach(lease)) => self.lease = Some(lease),
                    Some(Message::Detach) => self.lease = None,
                    Some(Message::Write(data, reply)) => match link.write(&data).await {
                        Ok(()) => {
                            if reply.send(Ok(())).is_err() {
                                tracing::debug!("a lease left before its write finished");
                            }
                        }
                        Err(error) => break End::Write(error, reply),
                    },
                    Some(Message::Close(ack)) => break End::Close(Some(ack)),
                    None => break End::Close(None),
                },
            }
        };
        // Forgotten and released before anyone hears, so the next open really opens the port.
        if let Some(ports) = self.ports.upgrade() {
            let mut entries = ports.entries();
            if entries
                .get(&self.path)
                .is_some_and(|entry| entry.id == self.id)
            {
                entries.remove(&self.path);
            }
        }
        link.close().await;
        match end {
            End::Read(Some(error)) => {
                if let Some(lease) = &self.lease
                    && lease.send(Err(error)).is_err()
                {
                    tracing::debug!("the lease left before its read failure");
                }
            }
            End::Write(error, reply) => {
                if reply.send(Err(error)).is_err() {
                    tracing::debug!("a lease left before its write failed");
                }
            }
            End::Close(Some(ack)) => {
                if ack.send(()).is_err() {
                    tracing::debug!("nobody waited for a held port to close");
                }
            }
            End::Read(None) | End::Close(None) => {}
        }
    }
}
