//! Frames for the MK2 bootloader, the protocol the vendor's firmware updater speaks after `ATR`.
//! Commands go out encrypted with a 16-byte wire key the caller supplies; replies come back clear.

use aes::Aes128;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, generic_array::GenericArray};
use sha2::{Digest, Sha256};

pub mod command {
    pub const READ_CHIP_ID: u8 = 0x00;
    pub const WRITE_CRC: u8 = 0x01;
    pub const READ_SERIAL: u8 = 0x02;
    pub const READ_CHECK: u8 = 0x03;
    pub const READ_VERSION: u8 = 0x04;
    pub const READ_BOOT_INFO: u8 = 0x05;
    pub const ERASE: u8 = 0x06;
    pub const WRITE: u8 = 0x07;
    /// Sent after the last write.
    pub const WRITE_DONE: u8 = 0x08;
    pub const RUN: u8 = 0x09;
    pub const READ_APP_INFO: u8 = 0x0b;
    pub const ERROR: u8 = 0x10;
    pub const ACK: u8 = 0x20;
}

/// The name the traffic log shows for a command, as the TypeScript server spells it.
pub const fn command_name(code: u8) -> Option<&'static str> {
    Some(match code {
        command::READ_CHIP_ID => "readChipId",
        command::WRITE_CRC => "writeCrc",
        command::READ_SERIAL => "readSerial",
        command::READ_CHECK => "readCheck",
        command::READ_VERSION => "readVersion",
        command::READ_BOOT_INFO => "readBootInfo",
        command::ERASE => "erase",
        command::WRITE => "write",
        command::WRITE_DONE => "writeDone",
        command::RUN => "run",
        command::READ_APP_INFO => "readAppInfo",
        command::ERROR => "error",
        command::ACK => "ack",
        _ => return None,
    })
}

/// The unencrypted probe the updater sends before reopening the port.
pub const PROBE_FRAME: [u8; 5] = [0xbb, 0xfe, 0xfe, 0xee, 0x0d];

pub const WIRE_KEY_LENGTH: usize = 16;
pub type WireKey = [u8; WIRE_KEY_LENGTH];

const FRAME_START: u8 = 0xbb;
const FRAME_END: u8 = 0xee;
const ESCAPE: u8 = 0xaa;
const BLOCK: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameErrorReason {
    Delimiters,
    Escape,
    Checksum,
    Length,
}

impl FrameErrorReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Delimiters => "delimiters",
            Self::Escape => "escape",
            Self::Checksum => "checksum",
            Self::Length => "length",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid bootloader frame ({}).", .reason.as_str())]
pub struct BootloaderFrameError {
    pub reason: FrameErrorReason,
}

impl From<FrameErrorReason> for BootloaderFrameError {
    fn from(reason: FrameErrorReason) -> Self {
        Self { reason }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandFrame {
    pub command: u8,
    pub payload: Vec<u8>,
    pub padding: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyFrame {
    pub command: u8,
    pub payload: Vec<u8>,
}

fn checksum(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0, |sum, &byte| sum.wrapping_add(byte))
}

const fn escape_code(byte: u8) -> Option<u8> {
    match byte {
        0xaa => Some(0x0a),
        0xbb => Some(0x0b),
        0xee => Some(0x0e),
        _ => None,
    }
}

const fn unescaped(code: u8) -> Option<u8> {
    match code {
        0x0a => Some(0xaa),
        0x0b => Some(0xbb),
        0x0e => Some(0xee),
        _ => None,
    }
}

fn stuff(out: &mut Vec<u8>, bytes: &[u8]) {
    for &byte in bytes {
        match escape_code(byte) {
            Some(code) => out.extend([ESCAPE, code]),
            None => out.push(byte),
        }
    }
}

fn frame(body: &[u8]) -> Vec<u8> {
    let mut out = vec![FRAME_START];
    stuff(&mut out, body);
    stuff(&mut out, &[checksum(body)]);
    out.push(FRAME_END);
    out
}

/// Always pads, a whole block when `length || payload` is already aligned.
pub const fn padding_length(payload_length: usize) -> usize {
    BLOCK - (payload_length + 2) % BLOCK
}

fn encrypt(wire_key: &WireKey, data: &mut [u8]) {
    let cipher = Aes128::new(GenericArray::from_slice(wire_key));
    for block in data.as_chunks_mut::<BLOCK>().0 {
        cipher.encrypt_block(GenericArray::from_mut_slice(block.as_mut_slice()));
    }
}

fn decrypt(wire_key: &WireKey, data: &mut [u8]) {
    let cipher = Aes128::new(GenericArray::from_slice(wire_key));
    for block in data.as_chunks_mut::<BLOCK>().0 {
        cipher.decrypt_block(GenericArray::from_mut_slice(block.as_mut_slice()));
    }
}

/// Random padding for a payload of this length. The vendor's padding is uninitialized stack
/// memory, so any bytes are accepted; zeros stand in if the system has no randomness to give.
pub fn random_padding(payload_length: usize) -> Vec<u8> {
    let mut padding = vec![0; padding_length(payload_length)];
    if getrandom::fill(&mut padding).is_err() {
        tracing::debug!("no randomness for bootloader padding; using zeros");
        padding.fill(0);
    }
    padding
}

/// `BB stuff(command, AES(length_be16, payload, padding), checksum) EE`, with the caller's
/// padding (see [`random_padding`]).
pub fn encode_command_frame(
    command: u8,
    payload: &[u8],
    wire_key: &WireKey,
    padding: &[u8],
) -> Result<Vec<u8>, BootloaderFrameError> {
    let length = u16::try_from(payload.len()).map_err(|_| FrameErrorReason::Length)?;
    if padding.len() != padding_length(payload.len()) {
        return Err(FrameErrorReason::Length.into());
    }
    let mut body = vec![command];
    body.extend(length.to_be_bytes());
    body.extend(payload);
    body.extend(padding);
    encrypt(wire_key, &mut body[1..]);
    Ok(frame(&body))
}

/// Replies travel in the clear: `BB stuff(command, payload, checksum) EE`.
pub fn encode_reply_frame(command: u8, payload: &[u8]) -> Vec<u8> {
    let mut body = vec![command];
    body.extend(payload);
    frame(&body)
}

/// Checks delimiters, escapes and checksum; the payload is whatever follows the command byte.
pub fn decode_reply_frame(frame: &[u8]) -> Result<ReplyFrame, BootloaderFrameError> {
    let inner = match frame {
        [FRAME_START, inner @ .., FRAME_END] => inner,
        _ => return Err(FrameErrorReason::Delimiters.into()),
    };
    let mut bytes = Vec::with_capacity(inner.len());
    let mut iter = inner.iter();
    while let Some(&byte) = iter.next() {
        if byte != ESCAPE {
            bytes.push(byte);
            continue;
        }
        let code = iter.next().copied().ok_or(FrameErrorReason::Escape)?;
        bytes.push(unescaped(code).ok_or(FrameErrorReason::Escape)?);
    }
    let Some((&sum, content)) = bytes.split_last() else {
        return Err(FrameErrorReason::Length.into());
    };
    let Some((&command, payload)) = content.split_first() else {
        return Err(FrameErrorReason::Length.into());
    };
    if checksum(content) != sum {
        return Err(FrameErrorReason::Checksum.into());
    }
    Ok(ReplyFrame {
        command,
        payload: payload.to_vec(),
    })
}

pub fn decode_command_frame(
    frame: &[u8],
    wire_key: &WireKey,
) -> Result<CommandFrame, BootloaderFrameError> {
    let ReplyFrame {
        command,
        payload: mut plain,
    } = decode_reply_frame(frame)?;
    if plain.is_empty() || plain.len() % BLOCK != 0 {
        return Err(FrameErrorReason::Length.into());
    }
    decrypt(wire_key, &mut plain);
    let length = usize::from(u16::from_be_bytes([plain[0], plain[1]]));
    if plain.len() != 2 + length + padding_length(length) {
        return Err(FrameErrorReason::Length.into());
    }
    let padding = plain.split_off(2 + length);
    Ok(CommandFrame {
        command,
        payload: plain.split_off(2),
        padding,
    })
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// SHA-256 of a wire key, so a key can be recognized without the key itself in the source.
pub fn wire_key_fingerprint(wire_key: &[u8]) -> String {
    to_hex(&Sha256::digest(wire_key))
}

/// SHA-256 of the MK2 bootloader's wire key. The key itself is never in the source; this hash both
/// recognizes a supplied key and lets [`find_wire_key`] recover the key from the vendor tool.
pub const VENDOR_WIRE_KEY_SHA256: &str =
    "2d892f5f5ff0f613b75d1feea642910b064e7f35a5e616264dc039c90a082243";

/// Windows hashed between yields, so a multi-megabyte scan never holds a worker for long.
pub const WIRE_KEY_SCAN_SLICE: usize = 1 << 15;

/// Scans a buffer for the 16-byte window whose SHA-256 matches `sha256`, returning a copy of it.
/// Finding it by hash (not a fixed offset) is self-verifying and survives vendor-version layout
/// shifts; the match is proof the right bytes were found. Dropping the future stops the scan
/// between slices.
#[tracing::instrument(name = "findWireKey", skip_all, fields(bytes = data.len()))]
pub async fn find_wire_key(data: &[u8], sha256: &str) -> Option<WireKey> {
    let windows = (data.len() + 1).saturating_sub(WIRE_KEY_LENGTH);
    let mut start = 0;
    while start < windows {
        if start > 0 {
            tokio::task::yield_now().await;
        }
        let end = windows.min(start + WIRE_KEY_SCAN_SLICE);
        let found = (start..end)
            .map(|i| &data[i..i + WIRE_KEY_LENGTH])
            .find(|window| to_hex(&Sha256::digest(window)) == sha256);
        if let Some(window) = found {
            return window.try_into().ok();
        }
        start = end;
    }
    None
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// The FIPS-197 example key, standing in for the wire key the user supplies.
    pub(crate) const TEST_KEY: WireKey = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    pub(crate) fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Polls a future once, for tests that start work and then let it go: `None` while it runs.
    pub(crate) async fn started<F: std::future::Future>(work: F) -> Option<F::Output> {
        let mut work = std::pin::pin!(work);
        std::future::poll_fn(|cx| {
            std::task::Poll::Ready(match work.as_mut().poll(cx) {
                std::task::Poll::Ready(value) => Some(value),
                std::task::Poll::Pending => None,
            })
        })
        .await
    }

    pub(crate) fn hex(data: &[u8]) -> String {
        data.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    // From the reference encoder that reproduced a capture of the vendor updater byte for byte.
    const GOLDEN: [(&str, u8, &str, &str, &str); 3] = [
        (
            "an empty request",
            command::READ_CHIP_ID,
            "",
            "a0a1a2a3a4a5a6a7a8a9aaabacad",
            "bb0042907530f8584122f38ae6ef36fc9bb4fdee",
        ),
        (
            "a write whose payload holds every escaped byte",
            command::WRITE,
            "08003800000aaabbee0102aabbee0304",
            "303132333435363738393a3b3c3d",
            "bb076044c2ce96dd1bf17fe4b0ccecaf297e67e6223bf32a071ffcb83f18679b9b55c5ee",
        ),
        (
            "an aligned payload, which still gets a full padding block",
            command::READ_CHECK,
            "0000000000000000000000000000",
            "55555555555555555555555555555555",
            "bb03c846abf5e5514dd92bde03027407adfaa5548f94150184202f8200aa0aa9d02d566aee",
        ),
    ];

    #[test]
    fn encodes_and_decodes_golden_frames() {
        for (name, command, payload, padding, frame) in GOLDEN {
            let encoded =
                encode_command_frame(command, &bytes(payload), &TEST_KEY, &bytes(padding)).unwrap();
            assert_eq!(hex(&encoded), frame, "{name}");
            let decoded = decode_command_frame(&encoded, &TEST_KEY).unwrap();
            assert_eq!(
                (
                    decoded.command,
                    hex(&decoded.payload),
                    hex(&decoded.padding)
                ),
                (command, payload.to_owned(), padding.to_owned()),
                "{name}"
            );
        }
    }

    #[test]
    fn pads_to_the_next_block_never_by_zero_bytes() {
        assert_eq!([0, 13, 14, 30].map(padding_length), [14, 1, 16, 16]);
        let frame =
            encode_command_frame(command::RUN, &bytes("08003800"), &TEST_KEY, &[7; 10]).unwrap();
        assert_eq!(
            decode_command_frame(&frame, &TEST_KEY)
                .unwrap()
                .padding
                .len(),
            10
        );
        let random = encode_command_frame(
            command::RUN,
            &bytes("08003800"),
            &TEST_KEY,
            &random_padding(4),
        )
        .unwrap();
        assert_eq!(
            decode_command_frame(&random, &TEST_KEY)
                .unwrap()
                .padding
                .len(),
            10
        );
        let wrong = encode_command_frame(command::RUN, &bytes("08003800"), &TEST_KEY, &[7; 9]);
        assert_eq!(wrong.unwrap_err().reason, FrameErrorReason::Length);
    }

    #[test]
    fn reads_clear_replies_unescaping_the_payload() {
        assert_eq!(
            decode_reply_frame(&bytes("bb200020ee")).unwrap(),
            ReplyFrame {
                command: command::ACK,
                payload: vec![0]
            }
        );
        assert_eq!(
            decode_reply_frame(&bytes("bb00aa0baa0ea9ee"))
                .unwrap()
                .payload,
            [0xbb, 0xee]
        );
    }

    #[test]
    fn rejects_malformed_replies() {
        for (name, frame, reason) in [
            ("no start byte", "200020ee", FrameErrorReason::Delimiters),
            ("no end byte", "bb200020", FrameErrorReason::Delimiters),
            (
                "an unknown escape",
                "bb20aa0120ee",
                FrameErrorReason::Escape,
            ),
            ("a wrong checksum", "bb200021ee", FrameErrorReason::Checksum),
            ("no checksum", "bb20ee", FrameErrorReason::Length),
        ] {
            assert_eq!(
                decode_reply_frame(&bytes(frame)).unwrap_err().reason,
                reason,
                "{name}"
            );
        }
    }

    #[test]
    fn rejects_a_command_whose_ciphertext_is_not_whole_blocks() {
        let result = decode_command_frame(&bytes("bb070102030dee"), &TEST_KEY);
        assert_eq!(result.unwrap_err().reason, FrameErrorReason::Length);
    }

    mod find_wire_key {
        use super::*;

        // A stand-in key planted in surrounding bytes; the scan is verified by its hash, so the
        // real vendor key never has to be in the source to prove the mechanism.
        fn planted() -> Vec<u8> {
            (0..16u32).map(|i| ((i * 37 + 11) & 0xff) as u8).collect()
        }

        fn noise(n: usize, seed: usize) -> Vec<u8> {
            (0..n).map(|i| ((i * 131 + seed) & 0xff) as u8).collect()
        }

        fn buffer() -> Vec<u8> {
            [noise(500, 3), planted(), noise(700, 9)].concat()
        }

        #[tokio::test]
        async fn recovers_the_window_whose_hash_matches_byte_for_byte() {
            let fingerprint = wire_key_fingerprint(&planted());
            let found = find_wire_key(&buffer(), &fingerprint).await;
            assert_eq!(found.map(|key| hex(&key)), Some(hex(&planted())));
        }

        #[tokio::test]
        async fn returns_none_when_no_window_matches() {
            let fingerprint = wire_key_fingerprint(&planted());
            assert_eq!(find_wire_key(&noise(1000, 1), &fingerprint).await, None);
        }

        #[tokio::test]
        async fn returns_none_for_a_buffer_shorter_than_the_key() {
            let fingerprint = wire_key_fingerprint(&planted());
            assert_eq!(find_wire_key(&planted()[..15], &fingerprint).await, None);
        }

        fn large() -> Arc<Vec<u8>> {
            Arc::new(noise(2 * WIRE_KEY_SCAN_SLICE + 16, 5))
        }

        #[tokio::test]
        async fn lets_other_work_run_between_slices_of_a_long_scan() {
            let fingerprint = wire_key_fingerprint(&planted());
            let order = Arc::new(Mutex::new(Vec::new()));
            let (data, log) = (large(), Arc::clone(&order));
            let scan = tokio::spawn(async move {
                let found = find_wire_key(&data, &fingerprint).await;
                log.lock().unwrap().push("scan done");
                found
            });
            let log = Arc::clone(&order);
            let other = tokio::spawn(async move { log.lock().unwrap().push("other work") });
            assert_eq!(scan.await.unwrap(), None);
            other.await.unwrap();
            assert_eq!(*order.lock().unwrap(), ["other work", "scan done"]);
        }

        #[tokio::test]
        async fn can_be_dropped_mid_scan() {
            let fingerprint = wire_key_fingerprint(&planted());
            let data = large();
            assert_eq!(started(find_wire_key(&data, &fingerprint)).await, None);
        }
    }
}
