//! JavaScript number and string semantics the TypeScript code relies on, so ported logic
//! produces the same output.

/// `Math.round`: halves round towards positive infinity.
pub fn math_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Number.prototype.toString()` in base 10, e.g. `1000`, `14.2`, `1e+21`, `NaN`.
pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(n as usize);
        format!("{int}.{frac}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let exponent = n - 1;
        let exponent_sign = if exponent < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        let fraction = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        format!("{first}{fraction}e{exponent_sign}{}", exponent.abs())
    };
    format!("{sign}{body}")
}

/// `Number.parseInt(text, 16)`: leading whitespace, a sign and `0x` are skipped, then the
/// longest run of hex digits is read. `None` where JavaScript returns `NaN`.
pub fn parse_int_hex(text: &str) -> Option<f64> {
    let text = text.trim_start_matches(is_whitespace);
    let (negative, text) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let text = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    let mut value: Option<f64> = None;
    for digit in text.chars().map_while(|c| c.to_digit(16)) {
        value = Some(value.unwrap_or(0.0) * 16.0 + f64::from(digit));
    }
    value.map(|value| if negative { -value } else { value })
}

/// `Number(text)`: trims whitespace, reads `""` as 0, takes `0x`/`0o`/`0b` integers, signed
/// decimals and `Infinity`. `NaN` where JavaScript returns `NaN`.
pub fn number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = match text.get(..2).map(str::to_ascii_lowercase).as_deref() {
        Some("0x") => 16,
        Some("0o") => 8,
        Some("0b") => 2,
        _ => 10,
    };
    if radix != 10 {
        let digits = &text[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        return digits
            .chars()
            .try_fold(0.0, |value, c| {
                c.to_digit(radix)
                    .map(|digit| value * f64::from(radix) + f64::from(digit))
            })
            .unwrap_or(f64::NAN);
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let (mantissa, exponent) = unsigned
        .split_once(['e', 'E'])
        .map_or((unsigned, None), |(mantissa, exponent)| {
            (mantissa, Some(exponent))
        });
    let (int, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |part: &str| part.chars().all(|c| c.is_ascii_digit());
    let valid_mantissa =
        digits(int) && digits(fraction) && !(int.is_empty() && fraction.is_empty());
    let valid_exponent = exponent.is_none_or(|exponent| {
        let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        !exponent.is_empty() && digits(exponent)
    });
    if !(valid_mantissa && valid_exponent) {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// The characters `String.prototype.trim` and regex `\s` match.
pub fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// `String.prototype.length`, which counts UTF-16 code units.
pub fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers_like_javascript() {
        for (value, expected) in [
            (1000.0, "1000"),
            (14.2, "14.2"),
            (-64.0, "-64"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (-0.0, "0"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(number_to_string(value), expected);
        }
    }

    #[test]
    fn rounds_halves_up_like_math_round() {
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(-40.5), -40.0);
        assert_eq!(math_round(0.49999999999999994), 0.0);
    }

    #[test]
    fn parses_hex_prefixes_like_parse_int() {
        assert_eq!(parse_int_hex("1F"), Some(31.0));
        assert_eq!(parse_int_hex("0x1F"), Some(31.0));
        assert_eq!(parse_int_hex("31z"), Some(49.0));
        assert_eq!(parse_int_hex("-1"), Some(-1.0));
        assert_eq!(parse_int_hex("zz"), None);
        assert_eq!(parse_int_hex(""), None);
    }

    #[test]
    fn converts_strings_like_number() {
        for (text, expected) in [
            ("", 0.0),
            ("  13.8 ", 13.8),
            ("-10", -10.0),
            ("+.5", 0.5),
            ("1.", 1.0),
            ("1E3", 1000.0),
            ("0X1F", 31.0),
            ("0b101", 5.0),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(number(text), expected, "{text:?}");
        }
        for text in [
            "abc", "1,2", ".", "1e", "-0x10", "0x", "inf", "NaN", "1_000", "e5",
        ] {
            assert!(number(text).is_nan(), "{text:?}");
        }
    }
}
