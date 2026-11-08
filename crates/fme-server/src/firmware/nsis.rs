//! Just enough of the NSIS installer format to take files out of the vendor package: a stub, a
//! first header on a 512-byte boundary, then one solid LZMA stream of length-prefixed blocks (the
//! install script first, then each file). Files are picked by SHA-256, so the script with their
//! names is never parsed and only bytes the caller already trusts come out.

use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};

use lzma_rust2::LzmaReader;
use sha2::{Digest, Sha256};

const ALIGNMENT: usize = 512;
const FIRST_HEADER_LENGTH: usize = 28;
const SIGNATURE: [u8; 4] = 0xdead_beef_u32.to_le_bytes();
const MAGIC: &[u8; 12] = b"NullsoftInst";
/// LZMA properties encode `(pb * 5 + lp) * 9 + lc` with pb, lp at most 4 and lc at most 8.
const MAX_PROPERTIES: u8 = 9 * 5 * 5;
const MAX_DICTIONARY: u32 = 1 << 26;
const CHUNK: usize = 1 << 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NsisErrorReason {
    NotAnInstaller,
    Unsupported,
    Corrupt,
    Missing,
    Cancelled,
}

impl NsisErrorReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotAnInstaller => "notAnInstaller",
            Self::Unsupported => "unsupported",
            Self::Corrupt => "corrupt",
            Self::Missing => "missing",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("The installer couldn't be unpacked ({}).", .reason.as_str())]
pub struct NsisError {
    pub reason: NsisErrorReason,
    #[source]
    pub source: Option<io::Error>,
}

impl From<NsisErrorReason> for NsisError {
    fn from(reason: NsisErrorReason) -> Self {
        Self {
            reason,
            source: None,
        }
    }
}

fn corrupt(source: io::Error) -> NsisError {
    NsisError {
        reason: NsisErrorReason::Corrupt,
        source: Some(source),
    }
}

fn compressed_stream(installer: &[u8]) -> Result<&[u8], NsisError> {
    let start = (0..installer.len())
        .step_by(ALIGNMENT)
        .find(|&at| {
            installer.get(at + 4..at + 8) == Some(SIGNATURE.as_slice())
                && installer.get(at + 8..at + 20) == Some(MAGIC.as_slice())
        })
        .ok_or(NsisErrorReason::NotAnInstaller)?;
    let field = |at: usize| {
        installer
            .get(start + at..start + at + 4)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_le_bytes)
    };
    let total = field(24).ok_or(NsisErrorReason::NotAnInstaller)? as usize;
    let end = installer.len().min(start.saturating_add(total));
    installer
        .get(start + FIRST_HEADER_LENGTH..end)
        .ok_or_else(|| NsisErrorReason::NotAnInstaller.into())
}

/// Reads a whole block, hashing it as it goes. Its bytes are kept only when it is at most
/// `keep_up_to` long.
fn read_block(
    stream: &mut impl Read,
    length: usize,
    keep_up_to: usize,
    cancel: &AtomicBool,
) -> Result<([u8; 32], Option<Vec<u8>>), NsisError> {
    let mut hash = Sha256::new();
    let mut kept = (length <= keep_up_to).then(|| Vec::with_capacity(length));
    let mut buffer = vec![0; CHUNK];
    let mut left = length;
    while left > 0 {
        if cancel.load(Ordering::Relaxed) {
            return Err(NsisErrorReason::Cancelled.into());
        }
        let chunk = &mut buffer[..left.min(CHUNK)];
        stream.read_exact(chunk).map_err(corrupt)?;
        hash.update(&*chunk);
        if let Some(kept) = &mut kept {
            kept.extend_from_slice(chunk);
        }
        left -= chunk.len();
    }
    Ok((hash.finalize().into(), kept))
}

/// The blocks whose SHA-256 is in `wanted`, in that order. Blocks longer than `keep_up_to` are
/// hashed but never held. Stops early once all are found, and between chunks once `cancel` is set.
pub fn extract_by_digest(
    installer: &[u8],
    wanted: &[[u8; 32]],
    keep_up_to: usize,
    cancel: &AtomicBool,
) -> Result<Vec<Vec<u8>>, NsisError> {
    let stream = compressed_stream(installer)?;
    let (&[properties, d0, d1, d2, d3], compressed) = stream
        .split_first_chunk::<5>()
        .ok_or(NsisErrorReason::NotAnInstaller)?;
    let dictionary = u32::from_le_bytes([d0, d1, d2, d3]);
    if properties >= MAX_PROPERTIES || dictionary > MAX_DICTIONARY {
        return Err(NsisErrorReason::Unsupported.into());
    }
    let mut reader = LzmaReader::new_with_props(compressed, u64::MAX, properties, dictionary, None)
        .map_err(corrupt)?;
    let mut found: Vec<Option<Vec<u8>>> = vec![None; wanted.len()];
    while found.iter().any(Option::is_none) {
        let mut length = [0; 4];
        match reader.read_exact(&mut length) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(corrupt(error)),
        }
        let length = u32::from_le_bytes(length) as usize;
        let (digest, bytes) = read_block(&mut reader, length, keep_up_to, cancel)?;
        if let (Some(index), Some(bytes)) = (wanted.iter().position(|w| *w == digest), bytes) {
            found[index] = Some(bytes);
        }
    }
    found
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| NsisErrorReason::Missing.into())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use lzma_rust2::{LzmaOptions, LzmaWriter};

    use super::*;

    /// A synthetic installer: a stub, the first header, then one solid LZMA stream of the install
    /// script and each file, the way NSIS lays out the vendor package.
    pub(crate) fn installer(files: &[&[u8]]) -> Vec<u8> {
        let script = b"synthetic install script".as_slice();
        let mut blocks = Vec::new();
        for block in std::iter::once(script).chain(files.iter().copied()) {
            blocks.extend((block.len() as u32).to_le_bytes());
            blocks.extend(block);
        }
        let mut options = LzmaOptions::with_preset(1);
        options.dict_size = 1 << 16;
        let mut writer = LzmaWriter::new_no_header(Vec::new(), &options, true).unwrap();
        writer.write_all(&blocks).unwrap();
        let compressed = writer.finish().unwrap();

        let mut out = b"MZ".to_vec();
        out.resize(2 * ALIGNMENT, 0);
        out.extend(0u32.to_le_bytes());
        out.extend(SIGNATURE);
        out.extend(MAGIC);
        out.extend((script.len() as u32).to_le_bytes());
        out.extend(((FIRST_HEADER_LENGTH + 5 + compressed.len()) as u32).to_le_bytes());
        out.push(options.get_props());
        out.extend(options.dict_size.to_le_bytes());
        out.extend(compressed);
        out
    }

    pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
        Sha256::digest(data).into()
    }

    fn extract(installer: &[u8], wanted: &[&[u8]]) -> Result<Vec<Vec<u8>>, NsisErrorReason> {
        let wanted: Vec<_> = wanted.iter().map(|file| sha256(file)).collect();
        extract_by_digest(installer, &wanted, 1 << 20, &AtomicBool::new(false))
            .map_err(|error| error.reason)
    }

    #[test]
    fn takes_out_the_wanted_files_by_digest_in_the_asked_order() {
        let big = vec![9; 3 * CHUNK + 5];
        let package = installer(&[b"skipped", b"first", &big, b"second"]);
        assert_eq!(
            extract(&package, &[b"second", &big, b"first"]),
            Ok(vec![b"second".to_vec(), big.clone(), b"first".to_vec()])
        );
    }

    #[test]
    fn hashes_but_never_holds_blocks_past_the_size_limit() {
        let big = vec![9; 64];
        let package = installer(&[&big]);
        let wanted = [sha256(&big)];
        let result = extract_by_digest(&package, &wanted, 63, &AtomicBool::new(false));
        assert_eq!(result.unwrap_err().reason, NsisErrorReason::Missing);
    }

    #[test]
    fn refuses_what_it_cant_unpack() {
        let package = installer(&[b"file"]);
        let mut wrong_properties = package.clone();
        wrong_properties[2 * ALIGNMENT + FIRST_HEADER_LENGTH] = MAX_PROPERTIES;
        let mut truncated = package.clone();
        truncated.truncate(truncated.len() - 8);
        for (name, bytes, reason) in [
            (
                "no first header",
                b"MZ plain bytes".to_vec(),
                NsisErrorReason::NotAnInstaller,
            ),
            (
                "bad LZMA properties",
                wrong_properties,
                NsisErrorReason::Unsupported,
            ),
            ("a cut-off stream", truncated, NsisErrorReason::Corrupt),
        ] {
            assert_eq!(extract(&bytes, &[b"file"]), Err(reason), "{name}");
        }
        assert_eq!(
            extract(&package, &[b"absent"]),
            Err(NsisErrorReason::Missing)
        );
    }

    #[test]
    fn stops_once_cancelled() {
        let package = installer(&[b"file"]);
        let result = extract_by_digest(&package, &[sha256(b"file")], 64, &AtomicBool::new(true));
        assert_eq!(result.unwrap_err().reason, NsisErrorReason::Cancelled);
    }
}
