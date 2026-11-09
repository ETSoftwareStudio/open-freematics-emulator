/// A `Schema.Literals` union of strings: a fieldless enum that encodes as its literal, with
/// `ALL`, `as_str`, `Display` and `FromStr`. The calling crate needs `serde` as a dependency.
///
/// ```
/// effect_rpc::string_enum! {
///     /// `Schema.Literals(["on", "off"])`
///     pub enum Switch { On => "on", Off => "off" }
/// }
///
/// assert_eq!(serde_json::to_string(&Switch::On).ok().as_deref(), Some(r#""on""#));
/// assert!("dim".parse::<Switch>().is_err());
/// ```
#[macro_export]
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
            type Err = $crate::schema::InvalidValue;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    _ => Err($crate::schema::InvalidValue::new(stringify!($name), value)),
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

/// A `Schema.TaggedError` or `Schema.TaggedStruct`, encoded as `{ "_tag": $tag, ...fields }` with
/// camelCase field names. Decoding rejects any other `_tag`, which serde's own
/// `#[serde(tag)]` on a struct does not. The calling crate needs `serde` as a dependency.
///
/// ```
/// effect_rpc::tagged_struct! {
///     #[derive(Debug, PartialEq)]
///     pub struct NotFound("NotFound") {
///         pub item_id: String,
///     }
/// }
///
/// let error = NotFound { item_id: "a".to_owned() };
/// let json = serde_json::json!({ "_tag": "NotFound", "itemId": "a" });
/// assert_eq!(serde_json::to_value(&error).ok(), Some(json.clone()));
/// assert_eq!(serde_json::from_value::<NotFound>(json).ok(), Some(error));
/// assert!(serde_json::from_value::<NotFound>(serde_json::json!({ "_tag": "Gone", "itemId": "a" })).is_err());
/// ```
#[macro_export]
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
