//! Splits the emulator's byte stream into lines. The firmware ends lines with `\r`,
//! sometimes followed by `\n`; blank lines carry nothing and are dropped.

use crate::js;

#[derive(Debug, Clone, Default)]
pub struct LineFramer {
    buffer: String,
}

impl LineFramer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        let bytes = self.buffer.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let end = match bytes[i] {
                b'\r' if bytes.get(i + 1) == Some(&b'\n') => Some(i + 2),
                b'\r' | b'\n' => Some(i + 1),
                _ => None,
            };
            if let Some(end) = end {
                let line = js::trim(&self.buffer[start..i]);
                if !line.is_empty() {
                    lines.push(line.to_owned());
                }
                start = end;
                i = end;
            } else {
                i += 1;
            }
        }
        self.buffer.drain(..start);
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_lines_split_across_chunks_and_drops_blanks() {
        let mut framer = LineFramer::new();
        assert!(framer.push("O").is_empty());
        assert_eq!(framer.push("K\r\n\r1FA"), ["OK"]);
        assert_eq!(framer.push("FP45S5\rERROR\r"), ["1FAFP45S5", "ERROR"]);
    }
}
