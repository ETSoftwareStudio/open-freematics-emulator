/// A `Schema.Literals` union of strings: a fieldless enum that encodes as its literal.
macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident { $($variant:ident => $value:literal),+ $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }
        }

        impl ::core::fmt::Display for $name {
            fn fmt(&self, f: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl ::core::str::FromStr for $name {
            type Err = $crate::json::InvalidValue;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    _ => Err($crate::json::InvalidValue::new(stringify!($name), value)),
                }
            }
        }

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <String as ::serde::Deserialize>::deserialize(deserializer)?;
                value.parse().map_err(::serde::de::Error::custom)
            }
        }
    };
}

/// A branded string schema: a newtype that only holds values passing `$check`.
macro_rules! branded_string {
    ($(#[$meta:meta])* pub struct $name:ident; check = $check:path;) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(::std::borrow::Cow<'static, str>);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, $crate::json::InvalidValue> {
                let value = value.into();
                if $check(&value) {
                    Ok(Self(::std::borrow::Cow::Owned(value)))
                } else {
                    Err($crate::json::InvalidValue::new(stringify!($name), value))
                }
            }

            /// For catalog constants; a unit test checks each one.
            #[allow(dead_code)]
            pub(crate) const fn from_static(value: &'static str) -> Self {
                Self(::std::borrow::Cow::Borrowed(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0.into_owned()
            }
        }

        impl ::core::ops::Deref for $name {
            type Target = str;

            fn deref(&self) -> &str {
                &self.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl ::std::borrow::Borrow<str> for $name {
            fn borrow(&self) -> &str {
                &self.0
            }
        }

        impl ::core::fmt::Display for $name {
            fn fmt(&self, f: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl ::core::str::FromStr for $name {
            type Err = $crate::json::InvalidValue;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::new(value)
            }
        }

        impl TryFrom<String> for $name {
            type Error = $crate::json::InvalidValue;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = $crate::json::InvalidValue;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.into_string()
            }
        }

        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                *self.0 == *other
            }
        }

        impl PartialEq<&str> for $name {
            fn eq(&self, other: &&str) -> bool {
                *self.0 == **other
            }
        }

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <String as ::serde::Deserialize>::deserialize(deserializer)?;
                Self::new(value).map_err(::serde::de::Error::custom)
            }
        }
    };
}

/// A `Schema.TaggedError` (or other tagged struct) encoded as `{ "_tag": $tag, ...fields }`.
/// Serde ignores a struct-level tag when decoding, so decoding goes through a one-variant
/// internally tagged enum that rejects any other `_tag`.
macro_rules! tagged_struct {
    (
        $(#[$meta:meta])*
        pub struct $name:ident($tag:literal) {
            $($(#[$field_meta:meta])* pub $field:ident: $ty:ty),* $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(::serde::Serialize)]
        #[serde(tag = "_tag", rename = $tag, rename_all = "camelCase")]
        pub struct $name {
            $($(#[$field_meta])* pub $field: $ty),*
        }

        const _: () = {
            #[derive(::serde::Deserialize)]
            #[serde(tag = "_tag", rename_all_fields = "camelCase")]
            enum Repr {
                #[serde(rename = $tag)]
                Value { $($(#[$field_meta])* $field: $ty),* },
            }

            impl<'de> ::serde::Deserialize<'de> for $name {
                fn deserialize<D: ::serde::Deserializer<'de>>(
                    deserializer: D,
                ) -> Result<Self, D::Error> {
                    let Repr::Value { $($field),* } = Repr::deserialize(deserializer)?;
                    Ok($name { $($field),* })
                }
            }
        };
    };
}
