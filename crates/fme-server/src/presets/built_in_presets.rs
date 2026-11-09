//! Driving scenarios that ship with the app.

use fme_core::contracts::base_schemas::PidId;
use fme_core::contracts::presets::{Preset, PresetId, PresetPids};

struct Scenario {
    rpm: f64,
    speed: f64,
    load: f64,
    absolute_load: f64,
    throttle: f64,
    pedal: f64,
    map: f64,
    maf: f64,
    fuel_rate: f64,
    timing: f64,
    coolant: f64,
    intake_air: f64,
    oil: f64,
    ambient: f64,
}

// Every built-in sets the same PIDs, so switching between them never leaves one behind.
fn built_in(slug: &str, name: &str, s: &Scenario) -> Option<Preset> {
    let pids: PresetPids = [
        ("010C", s.rpm),
        ("010D", s.speed),
        ("0104", s.load),
        ("0143", s.absolute_load),
        ("0111", s.throttle),
        ("0149", s.pedal),
        ("010B", s.map),
        ("0110", s.maf),
        ("015E", s.fuel_rate),
        ("010E", s.timing),
        ("0105", s.coolant),
        ("010F", s.intake_air),
        ("015C", s.oil),
        ("0146", s.ambient),
    ]
    .into_iter()
    .map(|(pid, value)| Some((PidId::new(pid).ok()?, value)))
    .collect::<Option<_>>()?;
    Some(Preset {
        id: PresetId::new(format!("builtin:{slug}")).ok()?,
        name: name.to_owned(),
        built_in: true,
        pids,
    })
}

/// A 2.0 L naturally aspirated petrol engine. MAF follows RPM, MAP and volumetric
/// efficiency; fuel rate follows MAF at 14.7:1, or about 12.5:1 when cold or at full load.
pub fn built_in_presets() -> Vec<Preset> {
    [
        built_in(
            "idle",
            "Idle",
            &Scenario {
                rpm: 750.0,
                speed: 0.0,
                load: 25.0,
                absolute_load: 22.0,
                throttle: 14.0,
                pedal: 15.0,
                map: 30.0,
                maf: 3.2,
                fuel_rate: 1.05,
                timing: 10.0,
                coolant: 90.0,
                intake_air: 32.0,
                oil: 95.0,
                ambient: 22.0,
            },
        ),
        built_in(
            "cruise",
            "Cruise",
            &Scenario {
                rpm: 2350.0,
                speed: 72.0,
                load: 35.0,
                absolute_load: 31.0,
                throttle: 18.0,
                pedal: 24.0,
                map: 44.0,
                maf: 14.5,
                fuel_rate: 4.75,
                timing: 32.0,
                coolant: 90.0,
                intake_air: 28.0,
                oil: 98.0,
                ambient: 22.0,
            },
        ),
        built_in(
            "cold-start",
            "Cold start",
            &Scenario {
                rpm: 1250.0,
                speed: 0.0,
                load: 32.0,
                absolute_load: 28.0,
                throttle: 15.0,
                pedal: 15.0,
                map: 33.0,
                maf: 6.4,
                fuel_rate: 2.45,
                timing: 4.0,
                coolant: 6.0,
                intake_air: 7.0,
                oil: 6.0,
                ambient: 5.0,
            },
        ),
        built_in(
            "wide-open-throttle",
            "Wide-open throttle",
            &Scenario {
                rpm: 5500.0,
                speed: 98.0,
                load: 98.0,
                absolute_load: 92.0,
                throttle: 88.0,
                pedal: 84.0,
                map: 98.0,
                maf: 99.8,
                fuel_rate: 38.55,
                timing: 24.0,
                coolant: 96.0,
                intake_air: 30.0,
                oil: 108.0,
                ambient: 22.0,
            },
        ),
        built_in(
            "overheat",
            "Overheat",
            &Scenario {
                rpm: 820.0,
                speed: 0.0,
                load: 27.0,
                absolute_load: 24.0,
                throttle: 14.0,
                pedal: 15.0,
                map: 32.0,
                maf: 3.5,
                fuel_rate: 1.15,
                timing: 2.0,
                coolant: 118.0,
                intake_air: 55.0,
                oil: 128.0,
                ambient: 35.0,
            },
        ),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use fme_core::shared::pids::{clamp_pid_value, find_pid};

    use super::*;

    #[test]
    fn set_only_catalog_pids_each_to_a_value_its_range_and_step_allow() {
        for preset in built_in_presets() {
            for (pid, value) in &preset.pids {
                let definition = find_pid(pid);
                assert!(definition.is_some(), "{} {pid}", preset.name);
                if let Some(definition) = definition {
                    assert_eq!(
                        clamp_pid_value(definition, *value),
                        *value,
                        "{} {pid}",
                        preset.name
                    );
                }
            }
        }
    }

    #[test]
    fn all_set_the_same_pids_so_switching_between_them_leaves_nothing_behind() {
        let presets = built_in_presets();
        let pids: Vec<Vec<&PidId>> = presets
            .iter()
            .map(|preset| preset.pids.keys().collect())
            .collect();
        assert_eq!(pids[0].len(), 14);
        for other in &pids[1..] {
            assert_eq!(other, &pids[0]);
        }
    }

    #[test]
    fn are_read_only_and_uniquely_identified() {
        let presets = built_in_presets();
        let names: Vec<&str> = presets.iter().map(|preset| preset.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Idle",
                "Cruise",
                "Cold start",
                "Wide-open throttle",
                "Overheat"
            ]
        );
        let ids: HashSet<&PresetId> = presets.iter().map(|preset| &preset.id).collect();
        assert_eq!(ids.len(), presets.len());
        assert!(presets.iter().all(|preset| preset.built_in));
    }
}
