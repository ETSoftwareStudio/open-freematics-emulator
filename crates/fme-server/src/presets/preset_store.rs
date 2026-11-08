//! Built-in and user presets. User presets persist as `presets.json` in the data dir.

use std::io;
use std::path::{Path, PathBuf};

use fme_core::contracts::presets::{
    Preset, PresetChangeError, PresetId, PresetNotFoundError, PresetOperation, PresetPersistError,
    PresetPids, PresetReadOnlyError, SavePresetInput, preset_name,
};
use fme_core::contracts::rpc::ApplyPresetError;
use fme_core::json;
use fme_core::shared::pids::{clamp_pid_value, find_pid};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use tokio::sync::watch;

use super::built_in_presets::built_in_presets;
use crate::emulator::emulator_session::EmulatorSession;

const FILE_NAME: &str = "presets.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct StoredPreset {
    id: PresetId,
    #[serde(deserialize_with = "preset_name")]
    name: String,
    #[serde(with = "json::finite_record")]
    pids: PresetPids,
}

/// `Schema.Literal(1)`.
#[derive(Debug, Clone, Copy)]
struct Version;

impl Serialize for Version {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(1)
    }
}

impl<'de> Deserialize<'de> for Version {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let version = f64::deserialize(deserializer)?;
        if version == 1.0 {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(json::InvalidValue::new(
                "PresetFile.version",
                version.to_string(),
            )))
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PresetFile {
    version: Version,
    presets: Vec<StoredPreset>,
}

fn is_built_in(id: &PresetId) -> bool {
    id.starts_with("builtin:")
}

fn with_built_ins(users: &[StoredPreset]) -> Vec<Preset> {
    let mut presets = built_in_presets();
    presets.extend(users.iter().map(|stored| Preset {
        id: stored.id.clone(),
        name: stored.name.clone(),
        built_in: false,
        pids: stored.pids.clone(),
    }));
    presets
}

fn clamp_pids(pids: &PresetPids) -> PresetPids {
    pids.iter()
        .map(|(pid, value)| {
            let clamped =
                find_pid(pid).map_or(*value, |definition| clamp_pid_value(definition, *value));
            (pid.clone(), clamped)
        })
        .collect()
}

/// `Schema.Defect` encodes an `Error` as its name and message.
fn defect(name: &str, error: &dyn std::error::Error) -> serde_json::Value {
    serde_json::json!({ "name": name, "message": error.to_string() })
}

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

// A missing file is a first run. An unreadable one must not stop the server, and a corrupt one
// is moved aside so the next save doesn't destroy what the user may want back.
async fn load(file: &Path) -> Vec<StoredPreset> {
    let bytes = match tokio::fs::read(file).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            tracing::warn!(
                path = %file.display(),
                reason = ?error.kind(),
                "Could not read saved presets; starting without them."
            );
            return Vec::new();
        }
    };
    match serde_json::from_str::<PresetFile>(&String::from_utf8_lossy(&bytes)) {
        Ok(contents) => contents
            .presets
            .into_iter()
            .filter(|preset| !is_built_in(&preset.id))
            .collect(),
        Err(_) => {
            let moved_to = with_suffix(file, ".corrupt");
            if tokio::fs::rename(file, &moved_to).await.is_err() {
                tracing::debug!("could not move the corrupt presets aside");
            }
            tracing::warn!(
                path = %file.display(),
                moved_to = %moved_to.display(),
                "Saved presets are corrupt; moved them aside."
            );
            Vec::new()
        }
    }
}

#[derive(Debug)]
pub struct PresetStore {
    session: EmulatorSession,
    data_dir: PathBuf,
    file: PathBuf,
    users: watch::Sender<Vec<StoredPreset>>,
    presets: watch::Sender<Vec<Preset>>,
    // Saves and deletes run one at a time so each writes the list the previous one left.
    lock: tokio::sync::Mutex<()>,
}

impl PresetStore {
    pub async fn new(data_dir: impl Into<PathBuf>, session: EmulatorSession) -> Self {
        let data_dir = data_dir.into();
        let file = data_dir.join(FILE_NAME);
        let users = load(&file).await;
        let (presets, _) = watch::channel(with_built_ins(&users));
        let (users, _) = watch::channel(users);
        Self {
            session,
            data_dir,
            file,
            users,
            presets,
            lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Built-ins, then user presets in the order they were made. The current list, then every
    /// change.
    pub fn presets(&self) -> watch::Receiver<Vec<Preset>> {
        self.presets.subscribe()
    }

    fn persist_error(&self, cause: serde_json::Value) -> PresetPersistError {
        PresetPersistError {
            path: self.file.display().to_string(),
            cause,
        }
    }

    #[tracing::instrument(name = "PresetStore.persist", skip_all)]
    async fn persist(&self, presets: &[StoredPreset]) -> Result<(), PresetPersistError> {
        // Written beside the file, then renamed over it, so a crash never leaves half a file.
        let temporary = with_suffix(&self.file, &format!(".{}.tmp", uuid::Uuid::new_v4()));
        let file = PresetFile {
            version: Version,
            presets: presets.to_vec(),
        };
        let contents = serde_json::to_string_pretty(&file)
            .map_err(|error| self.persist_error(defect("SchemaError", &error)))?;
        let written = async {
            tokio::fs::create_dir_all(&self.data_dir).await?;
            tokio::fs::write(&temporary, format!("{contents}\n")).await?;
            tokio::fs::rename(&temporary, &self.file).await
        };
        written
            .await
            .map_err(|error| self.persist_error(defect("PlatformError", &error)))
    }

    async fn commit(&self, users: Vec<StoredPreset>) -> Result<(), PresetPersistError> {
        self.persist(&users).await?;
        self.presets.send_replace(with_built_ins(&users));
        self.users.send_replace(users);
        Ok(())
    }

    #[tracing::instrument(name = "PresetStore.apply", skip_all, fields(preset = %id))]
    pub async fn apply(&self, id: &PresetId) -> Result<(), ApplyPresetError> {
        let preset = self
            .presets
            .borrow()
            .iter()
            .find(|candidate| candidate.id == *id)
            .cloned();
        let preset = preset.ok_or_else(|| PresetNotFoundError { id: id.clone() })?;
        Ok(self.session.apply_preset(&preset).await?)
    }

    /// Creates a user preset without `id`, or renames and overwrites the one with it.
    #[tracing::instrument(name = "PresetStore.save", skip_all, fields(preset = tracing::field::Empty))]
    pub async fn save(&self, input: SavePresetInput) -> Result<Preset, PresetChangeError> {
        let _permit = self.lock.lock().await;
        let mut users = self.users.borrow().clone();
        let saved = match input.id {
            None => {
                let id = PresetId::new(format!("user:{}", uuid::Uuid::new_v4()))
                    .map_err(|invalid| self.persist_error(defect("Error", &invalid)))?;
                let created = StoredPreset {
                    id,
                    name: input.name,
                    pids: clamp_pids(&input.pids),
                };
                users.push(created.clone());
                created
            }
            Some(id) => {
                tracing::Span::current().record("preset", id.as_str());
                if is_built_in(&id) {
                    return Err(PresetReadOnlyError {
                        id,
                        operation: PresetOperation::Save,
                    }
                    .into());
                }
                let Some(slot) = users.iter_mut().find(|preset| preset.id == id) else {
                    return Err(PresetNotFoundError { id }.into());
                };
                *slot = StoredPreset {
                    id,
                    name: input.name,
                    pids: clamp_pids(&input.pids),
                };
                slot.clone()
            }
        };
        self.commit(users).await?;
        Ok(Preset {
            id: saved.id,
            name: saved.name,
            built_in: false,
            pids: saved.pids,
        })
    }

    #[tracing::instrument(name = "PresetStore.delete", skip_all, fields(preset = %id))]
    pub async fn delete(&self, id: &PresetId) -> Result<(), PresetChangeError> {
        let _permit = self.lock.lock().await;
        if is_built_in(id) {
            return Err(PresetReadOnlyError {
                id: id.clone(),
                operation: PresetOperation::Delete,
            }
            .into());
        }
        let mut users = self.users.borrow().clone();
        if !users.iter().any(|preset| preset.id == *id) {
            return Err(PresetNotFoundError { id: id.clone() }.into());
        }
        users.retain(|preset| preset.id != *id);
        Ok(self.commit(users).await?)
    }
}

#[cfg(test)]
mod tests {
    use fme_core::contracts::base_schemas::PidId;
    use fme_core::contracts::presets::PresetRef;
    use indexmap::IndexMap;

    use super::*;
    use crate::device::serial_ports::SerialPorts;
    use crate::device::simulated_device::SimulatedDevice;
    use crate::traffic::traffic_log::TrafficLog;

    fn session() -> EmulatorSession {
        EmulatorSession::new(SerialPorts, SimulatedDevice::default(), TrafficLog::new())
    }

    async fn store(data_dir: &Path) -> PresetStore {
        PresetStore::new(data_dir, session()).await
    }

    /// A directory that doesn't exist yet, as on a first run.
    fn temp_data_dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("data");
        (root, data_dir)
    }

    fn pids(values: &[(&str, f64)]) -> IndexMap<PidId, f64> {
        values
            .iter()
            .map(|(pid, value)| (PidId::new(*pid).unwrap(), *value))
            .collect()
    }

    fn save_input(id: Option<&PresetId>, name: &str, values: &[(&str, f64)]) -> SavePresetInput {
        SavePresetInput {
            id: id.cloned(),
            name: name.to_owned(),
            pids: pids(values),
        }
    }

    fn cruise() -> Preset {
        built_in_presets().swap_remove(1)
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test(start_paused = true)]
    async fn saves_user_presets_atomically_and_loads_them_after_a_restart() {
        let (_root, data_dir) = temp_data_dir();

        let kept = {
            let store = store(&data_dir).await;
            let created = store
                .save(save_input(
                    None,
                    "Track day",
                    &[("010C", 6200.4), ("010D", 300.0)],
                ))
                .await
                .unwrap();
            assert!(!created.built_in);
            assert_eq!(created.name, "Track day");
            assert_eq!(created.pids, pids(&[("010C", 6200.0), ("010D", 255.0)]));
            let doomed = store
                .save(save_input(None, "Scratch", &[("010C", 900.0)]))
                .await
                .unwrap();
            store
                .save(save_input(
                    Some(&created.id),
                    "Track night",
                    &[("010C", 5000.0)],
                ))
                .await
                .unwrap();
            store.delete(&doomed.id).await.unwrap();
            created.id
        };

        let reloaded = store(&data_dir).await.presets().borrow().clone();
        let built_ins = built_in_presets();
        assert_eq!(reloaded[..built_ins.len()], built_ins[..]);
        assert_eq!(
            reloaded[built_ins.len()..],
            [Preset {
                id: kept,
                name: "Track night".to_owned(),
                built_in: false,
                pids: pids(&[("010C", 5000.0)]),
            }]
        );
        assert_eq!(files_in(&data_dir), ["presets.json"]);
    }

    #[tokio::test(start_paused = true)]
    async fn starts_from_the_built_ins_when_the_file_is_corrupt_and_keeps_the_old_file() {
        let (_root, data_dir) = temp_data_dir();
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("presets.json"), r#"{"version": 1, "pre"#).unwrap();

        let store = store(&data_dir).await;
        assert_eq!(*store.presets().borrow(), built_in_presets());
        store
            .save(save_input(None, "Fresh", &[("010C", 800.0)]))
            .await
            .unwrap();

        assert_eq!(
            files_in(&data_dir),
            ["presets.json", "presets.json.corrupt"]
        );
        assert_eq!(
            std::fs::read_to_string(data_dir.join("presets.json.corrupt")).unwrap(),
            r#"{"version": 1, "pre"#
        );
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_changes_to_built_ins_and_to_presets_that_dont_exist() {
        let (_root, data_dir) = temp_data_dir();
        let store = store(&data_dir).await;
        let cruise = cruise();
        let save_error = store
            .save(SavePresetInput {
                id: Some(cruise.id.clone()),
                name: "My cruise".to_owned(),
                pids: cruise.pids.clone(),
            })
            .await
            .unwrap_err();
        assert_eq!(
            save_error,
            PresetReadOnlyError {
                id: cruise.id.clone(),
                operation: PresetOperation::Save,
            }
            .into()
        );
        let delete_error = store.delete(&cruise.id).await.unwrap_err();
        assert!(matches!(
            delete_error,
            PresetChangeError::ReadOnly(PresetReadOnlyError {
                operation: PresetOperation::Delete,
                ..
            })
        ));
        let missing = PresetId::new("user:missing").unwrap();
        assert_eq!(
            store.delete(&missing).await.unwrap_err(),
            PresetNotFoundError {
                id: missing.clone()
            }
            .into()
        );
        assert!(matches!(
            store.apply(&missing).await.unwrap_err(),
            ApplyPresetError::PresetNotFound(_)
        ));
        assert_eq!(*store.presets().borrow(), built_in_presets());
    }

    #[tokio::test(start_paused = true)]
    async fn applies_a_preset_by_id_and_records_it_in_the_emulator_state() {
        let (_root, data_dir) = temp_data_dir();
        let store = store(&data_dir).await;
        let cruise = cruise();
        store.apply(&cruise.id).await.unwrap();
        let state = store.session.state().borrow().clone();
        assert_eq!(
            state.last_preset,
            Some(PresetRef {
                id: PresetId::new("builtin:cruise").unwrap(),
                name: "Cruise".to_owned(),
            })
        );
        for (pid, value) in &cruise.pids {
            assert_eq!(state.pids.get(pid), Some(value), "{pid}");
        }
    }
}
