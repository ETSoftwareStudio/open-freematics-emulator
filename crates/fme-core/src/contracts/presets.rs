use effect_rpc::{schema, string_enum, tagged_struct};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize};

use super::base_schemas::PidId;
use crate::js;

fn is_preset_id(value: &str) -> bool {
    let rest = value
        .strip_prefix("builtin:")
        .or_else(|| value.strip_prefix("user:"));
    rest.is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

branded_string! {
    /// Built-ins are `builtin:<slug>`; user presets get `user:<uuid>`.
    pub struct PresetId;
    check = is_preset_id;
}

pub const MAX_PRESET_NAME_LENGTH: usize = 40;

/// `Schema.Trim` decodes by trimming, then the name must be non-empty and short.
pub fn preset_name<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let name = String::deserialize(deserializer)?;
    let trimmed = js::trim(&name);
    if trimmed.is_empty() || js::length(trimmed) > MAX_PRESET_NAME_LENGTH {
        Err(serde::de::Error::custom(schema::InvalidValue::new(
            "PresetName",
            name,
        )))
    } else {
        Ok(trimmed.to_owned())
    }
}

/// A preset only sets the PIDs it lists, in its listed order.
pub type PresetPids = IndexMap<PidId, f64>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: PresetId,
    #[serde(deserialize_with = "preset_name")]
    pub name: String,
    pub built_in: bool,
    #[serde(with = "schema::finite_record")]
    pub pids: PresetPids,
}

/// The last preset applied, as named when it was applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetRef {
    pub id: PresetId,
    pub name: String,
}

/// Without `id` it creates a user preset; with one it renames and overwrites that preset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavePresetInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<PresetId>,
    #[serde(deserialize_with = "preset_name")]
    pub name: String,
    #[serde(with = "schema::finite_record")]
    pub pids: PresetPids,
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("That preset no longer exists.")]
    pub struct PresetNotFoundError("PresetNotFoundError") {
        pub id: PresetId,
    }
}

string_enum! {
    pub enum PresetOperation {
        Save => "save",
        Delete => "delete",
    }
}

impl PresetOperation {
    fn read_only_message(self) -> &'static str {
        match self {
            Self::Save => "Built-in presets can't be changed. Save a copy instead.",
            Self::Delete => "Built-in presets can't be deleted.",
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", .operation.read_only_message())]
    pub struct PresetReadOnlyError("PresetReadOnlyError") {
        pub id: PresetId,
        pub operation: PresetOperation,
    }
}

tagged_struct! {
    /// `cause` is a `Schema.Defect`: any JSON, `{ name, message }` for an `Error`.
    #[derive(Debug, Clone, PartialEq, thiserror::Error)]
    #[error("Could not save presets to disk.")]
    pub struct PresetPersistError("PresetPersistError") {
        pub path: String,
        pub cause: serde_json::Value,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[serde(untagged)]
pub enum PresetChangeError {
    #[error(transparent)]
    NotFound(#[from] PresetNotFoundError),
    #[error(transparent)]
    ReadOnly(#[from] PresetReadOnlyError),
    #[error(transparent)]
    Persist(#[from] PresetPersistError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_preset_ids() {
        assert!(PresetId::new("builtin:cruise").is_ok());
        assert!(PresetId::new("user:0f8b-12").is_ok());
        assert!(PresetId::new("user:").is_err());
        assert!(PresetId::new("custom:idle").is_err());
        assert!(PresetId::new("user:Idle").is_err());
    }

    #[test]
    fn trims_preset_names_when_decoding() {
        let input: SavePresetInput =
            serde_json::from_str(r#"{"name":"  Cruise ","pids":{"010C":2350}}"#).unwrap();
        assert_eq!(input.name, "Cruise");
        assert!(serde_json::from_str::<SavePresetInput>(r#"{"name":"   ","pids":{}}"#).is_err());
        let long = format!(r#"{{"name":"{}","pids":{{}}}}"#, "x".repeat(41));
        assert!(serde_json::from_str::<SavePresetInput>(&long).is_err());
    }
}
