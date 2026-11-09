//! Serde helpers that encode values the way `Schema.toCodecJson` does, which is what
//! `RpcSerialization.json` puts on the wire.
//!
//! ```
//! #[derive(serde::Serialize, serde::Deserialize)]
//! struct Reading {
//!     // `Schema.Number`: `NaN` and the infinities travel as strings.
//!     #[serde(with = "effect_rpc::schema::number")]
//!     value: f64,
//!     // `Schema.Uint8Array`: a Base64 string.
//!     #[serde(with = "effect_rpc::schema::bytes")]
//!     raw: Vec<u8>,
//! }
//!
//! let reading = Reading { value: f64::NAN, raw: vec![1, 2] };
//! assert_eq!(
//!     serde_json::to_string(&reading).ok().as_deref(),
//!     Some(r#"{"value":"NaN","raw":"AQI="}"#),
//! );
//! ```

use std::fmt;
use std::hash::Hash;

use indexmap::IndexMap;
use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize, Serializer};

/// A value a schema rejects, such as a string outside a `Schema.Literals` union.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{value:?} is not a valid {schema}")]
pub struct InvalidValue {
    pub schema: &'static str,
    pub value: String,
}

impl InvalidValue {
    pub fn new(schema: &'static str, value: impl Into<String>) -> Self {
        Self {
            schema,
            value: value.into(),
        }
    }
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A JSON number as JavaScript writes it: integral values without a fraction, and with
/// `allow_non_finite` (plain `Schema.Number`) `NaN` and the infinities as strings.
struct Number<const ALLOW_NON_FINITE: bool>(f64);

impl<const ALLOW_NON_FINITE: bool> Serialize for Number<ALLOW_NON_FINITE> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = self.0;
        if value.is_nan() {
            serializer.serialize_str("NaN")
        } else if value.is_infinite() {
            serializer.serialize_str(if value > 0.0 { "Infinity" } else { "-Infinity" })
        } else if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
            serializer.serialize_i64(value as i64)
        } else {
            serializer.serialize_f64(value)
        }
    }
}

impl<'de, const ALLOW_NON_FINITE: bool> Deserialize<'de> for Number<ALLOW_NON_FINITE> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NumberVisitor<const ALLOW_NON_FINITE: bool>;

        impl<const ALLOW_NON_FINITE: bool> Visitor<'_> for NumberVisitor<ALLOW_NON_FINITE> {
            type Value = Number<ALLOW_NON_FINITE>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                if ALLOW_NON_FINITE {
                    f.write_str("a number or \"NaN\", \"Infinity\", \"-Infinity\"")
                } else {
                    f.write_str("a finite number")
                }
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(Number(value as f64))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(Number(value as f64))
            }

            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Ok(Number(value))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                match value {
                    "NaN" if ALLOW_NON_FINITE => Ok(Number(f64::NAN)),
                    "Infinity" if ALLOW_NON_FINITE => Ok(Number(f64::INFINITY)),
                    "-Infinity" if ALLOW_NON_FINITE => Ok(Number(f64::NEG_INFINITY)),
                    _ => Err(E::invalid_value(de::Unexpected::Str(value), &self)),
                }
            }
        }

        deserializer.deserialize_any(NumberVisitor)
    }
}

/// `Schema.Number`, for `#[serde(with)]`.
pub mod number {
    use super::*;

    pub fn serialize<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
        Number::<true>(*value).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
        Number::<true>::deserialize(deserializer).map(|number| number.0)
    }
}

/// `Schema.NullOr(Schema.Number)`.
pub mod number_or_null {
    use super::*;

    pub fn serialize<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
        value.map(Number::<true>).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<f64>, D::Error> {
        Ok(Option::<Number<true>>::deserialize(deserializer)?.map(|number| number.0))
    }
}

/// `Schema.Finite` and `Schema.Int`, for `#[serde(with)]`: always a plain JSON number.
pub mod finite {
    use super::*;

    pub fn serialize<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
        Number::<false>(*value).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
        Number::<false>::deserialize(deserializer).map(|number| number.0)
    }
}

fn serialize_map<K: Serialize, S: Serializer, const ALLOW_NON_FINITE: bool>(
    map: &IndexMap<K, f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(
        map.iter()
            .map(|(key, value)| (key, Number::<ALLOW_NON_FINITE>(*value))),
    )
}

fn deserialize_map<'de, K, D, const ALLOW_NON_FINITE: bool>(
    deserializer: D,
) -> Result<IndexMap<K, f64>, D::Error>
where
    K: Deserialize<'de> + Eq + Hash,
    D: Deserializer<'de>,
{
    let map = IndexMap::<K, Number<ALLOW_NON_FINITE>>::deserialize(deserializer)?;
    Ok(map
        .into_iter()
        .map(|(key, number)| (key, number.0))
        .collect())
}

/// `Schema.Record(Key, Schema.Number)`, in insertion order.
pub mod number_record {
    use super::*;

    pub fn serialize<K: Serialize, S: Serializer>(
        map: &IndexMap<K, f64>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serialize_map::<K, S, true>(map, serializer)
    }

    pub fn deserialize<'de, K, D>(deserializer: D) -> Result<IndexMap<K, f64>, D::Error>
    where
        K: Deserialize<'de> + Eq + Hash,
        D: Deserializer<'de>,
    {
        deserialize_map::<K, D, true>(deserializer)
    }
}

/// `Schema.Record(Key, Schema.Finite)`, in insertion order.
pub mod finite_record {
    use super::*;

    pub fn serialize<K: Serialize, S: Serializer>(
        map: &IndexMap<K, f64>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serialize_map::<K, S, false>(map, serializer)
    }

    pub fn deserialize<'de, K, D>(deserializer: D) -> Result<IndexMap<K, f64>, D::Error>
    where
        K: Deserialize<'de> + Eq + Hash,
        D: Deserializer<'de>,
    {
        deserialize_map::<K, D, false>(deserializer)
    }
}

/// `Schema.NonEmptyString`, for `#[serde(deserialize_with)]`.
pub fn non_empty_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        Err(de::Error::custom(InvalidValue::new(
            "NonEmptyString",
            value,
        )))
    } else {
        Ok(value)
    }
}

/// Decodes a value and checks it, as a `Schema` filter does. For `deserialize_with` functions.
pub fn checked<'de, T, D>(
    deserializer: D,
    schema: &'static str,
    check: impl FnOnce(&T) -> bool,
) -> Result<T, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    let value = T::deserialize(deserializer)?;
    if check(&value) {
        Ok(value)
    } else {
        Err(de::Error::custom(format_args!(
            "{schema} rejected the value"
        )))
    }
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Padded standard Base64, as Effect's `Encoding` writes it.
pub fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(char::from(BASE64_ALPHABET[((n >> shift) & 0x3f) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Effect's Base64 decoder: CR and LF are ignored, the length must be a multiple of four and
/// `=` may only pad the end.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let stripped: Vec<u8> = text
        .bytes()
        .filter(|b| *b != b'\r' && *b != b'\n')
        .collect();
    if !stripped.len().is_multiple_of(4) {
        return None;
    }
    let padding = stripped.iter().rev().take_while(|b| **b == b'=').count();
    if padding > 2 || stripped[..stripped.len() - padding].contains(&b'=') {
        return None;
    }
    let sextet = |b: u8| match b {
        b'A'..=b'Z' => Some(u32::from(b - b'A')),
        b'a'..=b'z' => Some(u32::from(b - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(b - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        b'=' => Some(0),
        _ => None,
    };
    let mut out = Vec::with_capacity(stripped.len() / 4 * 3);
    for chunk in stripped.chunks(4) {
        let mut n = 0u32;
        for b in chunk {
            n = (n << 6) | sextet(*b)?;
        }
        out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]);
    }
    out.truncate(out.len() - padding);
    Some(out)
}

/// `Schema.Uint8Array`, which `toCodecJson` encodes as a Base64 string.
pub mod bytes {
    use super::*;

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&encode_base64(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        decode_base64(&text).ok_or_else(|| de::Error::custom("expected a Base64 string"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Numbers {
        #[serde(with = "number")]
        number: f64,
        #[serde(with = "finite")]
        finite: f64,
        #[serde(with = "number_or_null")]
        maybe: Option<f64>,
    }

    #[test]
    fn encodes_numbers_like_to_codec_json() {
        for (number, encoded) in [
            (1000.0, json!(1000)),
            (14.2, json!(14.2)),
            (f64::NAN, json!("NaN")),
            (f64::INFINITY, json!("Infinity")),
            (f64::NEG_INFINITY, json!("-Infinity")),
        ] {
            let numbers = Numbers {
                number,
                finite: 2.0,
                maybe: None,
            };
            let value = serde_json::to_value(&numbers).unwrap();
            assert_eq!(
                value,
                json!({ "number": encoded, "finite": 2, "maybe": null })
            );
            let decoded: Numbers = serde_json::from_value(value).unwrap();
            assert!(decoded.number == number || number.is_nan() && decoded.number.is_nan());
        }
        let infinite = json!({ "number": 1, "finite": "Infinity", "maybe": null });
        assert!(serde_json::from_value::<Numbers>(infinite).is_err());
        assert!(serde_json::from_value::<Numbers>(Value::Null).is_err());
    }

    #[test]
    fn round_trips_base64() {
        for (bytes, text) in [
            (&b""[..], ""),
            (&b"f"[..], "Zg=="),
            (&b"fo"[..], "Zm8="),
            (&b"foo"[..], "Zm9v"),
            (&[0u8, 1, 2, 255][..], "AAEC/w=="),
        ] {
            assert_eq!(encode_base64(bytes), text);
            assert_eq!(decode_base64(text).as_deref(), Some(bytes));
        }
        assert_eq!(decode_base64("Zm9v\r\nZg=="), Some(b"foof".to_vec()));
        assert_eq!(decode_base64("Zg"), None);
        assert_eq!(decode_base64("Z=g="), None);
        assert_eq!(decode_base64("Zg=!"), None);
    }
}
