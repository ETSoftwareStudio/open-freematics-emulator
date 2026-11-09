use indexmap::IndexMap;

use crate::contracts::base_schemas::PidId;
use crate::contracts::presets::{Preset, PresetId, PresetPids};
use crate::shared::pids::find_pid;

pub type PidValues = IndexMap<PidId, f64>;

#[derive(Debug, Clone, PartialEq)]
pub struct PresetChange {
    pub pid: PidId,
    pub preset_value: f64,
    pub current_value: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PresetProvenance<'a> {
    Preset {
        preset: &'a Preset,
    },
    Edited {
        preset: &'a Preset,
        changes: Vec<PresetChange>,
    },
    Custom,
}

// Within half a step both values snap to the same setting, so the device reports the same thing.
fn same_setting(pid: &PidId, a: f64, b: f64) -> bool {
    (a - b).abs() < find_pid(pid).map_or(1.0, |definition| definition.step) / 2.0
}

/// The preset's PIDs whose current value differs from it, in the preset's order.
pub fn preset_changes(current: &PidValues, preset_pids: &PresetPids) -> Vec<PresetChange> {
    preset_pids
        .iter()
        .filter_map(|(pid, &preset_value)| {
            let current_value = *current.get(pid)?;
            (!same_setting(pid, preset_value, current_value)).then(|| PresetChange {
                pid: pid.clone(),
                preset_value,
                current_value,
            })
        })
        .collect()
}

/// The first preset every one of whose PIDs matches the current values.
pub fn find_matching_preset<'a>(current: &PidValues, presets: &'a [Preset]) -> Option<&'a Preset> {
    presets
        .iter()
        .find(|preset| !preset.pids.is_empty() && preset_changes(current, &preset.pids).is_empty())
}

/// What the PIDs show: the last applied preset, another preset the edits landed on, the last
/// preset with edits, or custom values once that preset is gone.
pub fn preset_provenance<'a>(
    current: &PidValues,
    presets: &'a [Preset],
    last_preset_id: Option<&PresetId>,
) -> PresetProvenance<'a> {
    let last = last_preset_id.and_then(|id| presets.iter().find(|preset| &preset.id == id));
    let changes = last.map_or_else(Vec::new, |last| preset_changes(current, &last.pids));
    if let Some(preset) = last
        && changes.is_empty()
    {
        return PresetProvenance::Preset { preset };
    }
    if let Some(preset) = find_matching_preset(current, presets) {
        return PresetProvenance::Preset { preset };
    }
    match last {
        Some(preset) => PresetProvenance::Edited { preset, changes },
        None => PresetProvenance::Custom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::default_state::make_default_state;

    fn pid(id: &str) -> PidId {
        PidId::new(id).unwrap()
    }

    fn preset(id: &str, name: &str, pids: &[(&str, f64)]) -> Preset {
        Preset {
            id: PresetId::new(id).unwrap(),
            name: name.to_owned(),
            built_in: id.starts_with("builtin:"),
            pids: pids.iter().map(|(id, value)| (pid(id), *value)).collect(),
        }
    }

    fn cruise() -> Preset {
        preset(
            "builtin:cruise",
            "Cruise",
            &[("010C", 2350.0), ("010D", 72.0), ("0110", 14.5)],
        )
    }

    fn idle() -> Preset {
        preset("builtin:idle", "Idle", &[("010C", 750.0), ("010D", 0.0)])
    }

    fn with_pids(values: &[(&str, f64)]) -> PidValues {
        let mut pids = make_default_state().pids;
        for (id, value) in values {
            pids.insert(pid(id), *value);
        }
        pids
    }

    fn change(id: &str, preset_value: f64, current_value: f64) -> PresetChange {
        PresetChange {
            pid: pid(id),
            preset_value,
            current_value,
        }
    }

    #[test]
    fn lists_differing_pids_in_the_presets_order_ignoring_differences_under_half_a_step() {
        let current = with_pids(&[("010C", 3100.0), ("010D", 72.4), ("0110", 14.504)]);
        assert_eq!(
            preset_changes(&current, &cruise().pids),
            [change("010C", 2350.0, 3100.0)]
        );
        let current = with_pids(&[("010C", 2350.0), ("010D", 72.0), ("0110", 14.52)]);
        assert_eq!(
            preset_changes(&current, &cruise().pids),
            [change("0110", 14.5, 14.52)]
        );
    }

    #[test]
    fn finds_the_preset_whose_pids_all_match_ignoring_pids_it_doesnt_set() {
        let presets = [idle(), cruise()];
        let found = find_matching_preset(
            &with_pids(&[("010C", 750.0), ("010D", 0.0), ("0105", 20.0)]),
            &presets,
        );
        assert!(found.is_some_and(|found| std::ptr::eq(found, &presets[0])));
        assert!(
            find_matching_preset(&with_pids(&[("010C", 760.0), ("010D", 0.0)]), &presets).is_none()
        );
        assert!(
            find_matching_preset(&with_pids(&[]), &[preset("user:empty", "Empty", &[])]).is_none()
        );
    }

    #[test]
    fn names_the_last_preset_its_edits_a_preset_the_edits_land_on_or_custom_values() {
        let presets = [idle(), cruise()];
        let cruise_id = cruise().id;
        let applied = with_pids(&[("010C", 2350.0), ("010D", 72.0), ("0110", 14.5)]);
        assert_eq!(
            preset_provenance(&applied, &presets, Some(&cruise_id)),
            PresetProvenance::Preset {
                preset: &presets[1]
            }
        );
        let mut edited = applied.clone();
        edited.insert(pid("010C"), 3100.0);
        assert_eq!(
            preset_provenance(&edited, &presets, Some(&cruise_id)),
            PresetProvenance::Edited {
                preset: &presets[1],
                changes: vec![change("010C", 2350.0, 3100.0)],
            }
        );
        assert_eq!(
            preset_provenance(
                &with_pids(&[("010C", 750.0), ("010D", 0.0)]),
                &presets,
                Some(&cruise_id)
            ),
            PresetProvenance::Preset {
                preset: &presets[0]
            }
        );
        assert_eq!(
            preset_provenance(&applied, &[idle()], Some(&cruise_id)),
            PresetProvenance::Custom
        );
        assert_eq!(
            preset_provenance(&with_pids(&[("010C", 3100.0)]), &presets, None),
            PresetProvenance::Custom
        );
    }
}
