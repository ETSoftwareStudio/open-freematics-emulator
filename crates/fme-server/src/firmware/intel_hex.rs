//! Intel HEX application images.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirmwareSegment {
    pub address: u64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirmwareImage {
    /// Contiguous runs of bytes, sorted by address.
    pub segments: Vec<FirmwareSegment>,
    /// From a start-linear-address record, when the file has one.
    pub entry: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntelHexReason {
    Syntax,
    Checksum,
    RecordType,
    Overlap,
    MissingEnd,
    Empty,
}

impl IntelHexReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Syntax => "syntax",
            Self::Checksum => "checksum",
            Self::RecordType => "recordType",
            Self::Overlap => "overlap",
            Self::MissingEnd => "missingEnd",
            Self::Empty => "empty",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Invalid Intel HEX file at line {line} ({}).", .reason.as_str())]
pub struct IntelHexError {
    pub line: u32,
    pub reason: IntelHexReason,
}

fn to_segments(bytes: BTreeMap<u64, u8>) -> Vec<FirmwareSegment> {
    let mut segments: Vec<FirmwareSegment> = Vec::new();
    for (address, byte) in bytes {
        match segments.last_mut() {
            Some(run) if run.address + run.data.len() as u64 == address => run.data.push(byte),
            _ => segments.push(FirmwareSegment {
                address,
                data: vec![byte],
            }),
        }
    }
    segments
}

fn decode_fields(record: &str) -> Option<Vec<u8>> {
    let digits = record.strip_prefix(':')?.as_bytes();
    if digits.is_empty() || digits.len() % 2 != 0 || !digits.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    digits
        .chunks(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(text, 16).ok()
        })
        .collect()
}

/// Lines split on `\n` or `\r\n` and trimmed of JavaScript whitespace, as `String.split` and
/// `trim` would.
pub fn parse_intel_hex(text: &str) -> Result<FirmwareImage, IntelHexError> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let mut bytes = BTreeMap::new();
    let mut base: u64 = 0;
    let mut entry = None;
    for (index, raw) in lines.iter().enumerate() {
        let line = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let fail = |reason| IntelHexError { line, reason };
        let record = fme_core::js::trim(raw);
        if record.is_empty() {
            continue;
        }
        let fields = decode_fields(record).ok_or(fail(IntelHexReason::Syntax))?;
        let count = usize::from(fields[0]);
        if fields.len() != count + 5 {
            return Err(fail(IntelHexReason::Syntax));
        }
        if fields.iter().fold(0u8, |sum, &byte| sum.wrapping_add(byte)) != 0 {
            return Err(fail(IntelHexReason::Checksum));
        }
        let offset = u64::from(u16::from_be_bytes([fields[1], fields[2]]));
        let data = &fields[4..4 + count];
        // JavaScript numbers don't wrap; saturating keeps absurd addresses out of range instead.
        let value = data.iter().fold(0u64, |acc, &byte| {
            acc.saturating_mul(256).saturating_add(u64::from(byte))
        });
        match fields[3] {
            0x00 => {
                for (i, &byte) in data.iter().enumerate() {
                    let address = base.saturating_add(offset).saturating_add(i as u64);
                    if bytes.insert(address, byte).is_some() {
                        return Err(fail(IntelHexReason::Overlap));
                    }
                }
            }
            0x01 if bytes.is_empty() => return Err(fail(IntelHexReason::Empty)),
            0x01 => {
                return Ok(FirmwareImage {
                    segments: to_segments(bytes),
                    entry,
                });
            }
            0x02 => base = value.saturating_mul(16),
            0x03 => {}
            0x04 => base = value.saturating_mul(0x10000),
            0x05 => entry = Some(value),
            _ => return Err(fail(IntelHexReason::RecordType)),
        }
    }
    Err(IntelHexError {
        line: u32::try_from(lines.len()).unwrap_or(u32::MAX),
        reason: IntelHexReason::MissingEnd,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn record(kind: u8, offset: u16, data: &[u8]) -> String {
        let mut fields = vec![data.len() as u8];
        fields.extend(offset.to_be_bytes());
        fields.push(kind);
        fields.extend(data);
        let sum = fields.iter().fold(0u8, |acc, &byte| acc.wrapping_add(byte));
        fields.push(sum.wrapping_neg());
        let digits: String = fields.iter().map(|byte| format!("{byte:02X}")).collect();
        format!(":{digits}")
    }

    /// Sixteen bytes a record, with an extended linear address record at each 64 KiB boundary.
    pub(crate) fn hex_file(address: u32, data: &[u8]) -> String {
        let mut lines = Vec::new();
        for (i, chunk) in data.chunks(16).enumerate() {
            let at = address + (i * 16) as u32;
            if i == 0 || at & 0xffff == 0 {
                lines.push(record(0x04, 0, &(at >> 16).to_be_bytes()[2..]));
            }
            lines.push(record(0x00, (at & 0xffff) as u16, chunk));
        }
        lines.push(record(0x01, 0, &[]));
        lines.join("\n")
    }

    #[test]
    fn joins_adjacent_records_into_segments_under_the_extended_linear_address() {
        let text = [
            record(0x04, 0, &[0x08, 0x00]),
            record(0x00, 0x3800, &[1, 2, 3, 4]),
            record(0x00, 0x3804, &[5, 6]),
            record(0x00, 0x3900, &[7]),
            record(0x05, 0, &[0x08, 0x00, 0x38, 0xed]),
            record(0x01, 0, &[]),
        ]
        .join("\r\n");
        assert_eq!(
            parse_intel_hex(&text).unwrap(),
            FirmwareImage {
                segments: vec![
                    FirmwareSegment {
                        address: 0x0800_3800,
                        data: vec![1, 2, 3, 4, 5, 6],
                    },
                    FirmwareSegment {
                        address: 0x0800_3900,
                        data: vec![7],
                    },
                ],
                entry: Some(0x0800_38ed),
            }
        );
    }

    #[test]
    fn rejects_malformed_files() {
        let extended = record(0x04, 0, &[0x08, 0x00]);
        let end = record(0x01, 0, &[]);
        let cases: [(&str, Vec<String>, u32, IntelHexReason); 7] = [
            (
                "a line without a colon",
                vec![extended.clone(), "0400".to_owned(), end.clone()],
                2,
                IntelHexReason::Syntax,
            ),
            (
                "a byte count that disagrees",
                vec![
                    extended.clone(),
                    format!("{}00", record(0x00, 0, &[1, 2])),
                    end.clone(),
                ],
                2,
                IntelHexReason::Syntax,
            ),
            (
                "a bad checksum",
                vec![extended.clone(), ":0100000001FF".to_owned(), end.clone()],
                2,
                IntelHexReason::Checksum,
            ),
            (
                "an unknown record type",
                vec![extended.clone(), record(0x06, 0, &[]), end.clone()],
                2,
                IntelHexReason::RecordType,
            ),
            (
                "two records for one address",
                vec![record(0x00, 0, &[1]), record(0x00, 0, &[1]), end.clone()],
                2,
                IntelHexReason::Overlap,
            ),
            (
                "no data",
                vec![extended.clone(), end],
                2,
                IntelHexReason::Empty,
            ),
            (
                "no end record",
                vec![extended, record(0x00, 0, &[1])],
                2,
                IntelHexReason::MissingEnd,
            ),
        ];
        for (name, lines, line, reason) in cases {
            assert_eq!(
                parse_intel_hex(&lines.join("\n")),
                Err(IntelHexError { line, reason }),
                "{name}"
            );
        }
    }
}
