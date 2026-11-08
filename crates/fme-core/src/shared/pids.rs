use effect_rpc::string_enum;

use crate::contracts::base_schemas::PidId;
use crate::js;

string_enum! {
    pub enum PidGroup {
        Engine => "Engine",
        SpeedAndDistance => "Speed & distance",
        Throttle => "Throttle",
        AirAndFuel => "Air & fuel",
        Temperatures => "Temperatures",
        Emissions => "Emissions",
    }
}

pub const PID_GROUPS: &[PidGroup] = PidGroup::ALL;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Width {
    One,
    Two,
}

/// Every catalog PID is linear: `value = raw * scale + offset`, big-endian over 1 or 2 bytes.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Linear {
    width: Width,
    scale: f64,
    offset: f64,
}

const fn linear(width: Width, scale: f64, offset: f64) -> Linear {
    Linear {
        width,
        scale,
        offset,
    }
}

impl Linear {
    fn encode(&self, value: f64) -> Vec<u8> {
        let max_raw = match self.width {
            Width::One => 255.0,
            Width::Two => 65535.0,
        };
        let raw = js::math_round((value - self.offset) / self.scale)
            .max(0.0)
            .min(max_raw) as u16;
        match self.width {
            Width::One => vec![raw as u8],
            Width::Two => vec![(raw >> 8) as u8, (raw & 0xff) as u8],
        }
    }

    fn decode(&self, data: &[u8]) -> f64 {
        let byte = |i: usize| u16::from(data.get(i).copied().unwrap_or(0));
        let raw = match self.width {
            Width::One => byte(0),
            Width::Two => (byte(0) << 8) | byte(1),
        };
        f64::from(raw) * self.scale + self.offset
    }
}

const PLAIN: Linear = linear(Width::One, 1.0, 0.0);
const WORD: Linear = linear(Width::Two, 1.0, 0.0);
const TEMPERATURE: Linear = linear(Width::One, 1.0, -40.0);
const PERCENT: Linear = linear(Width::One, 100.0 / 255.0, 0.0);
const TORQUE_PERCENT: Linear = linear(Width::One, 1.0, -125.0);
const CATALYST_TEMPERATURE: Linear = linear(Width::Two, 0.1, -40.0);

#[derive(Debug, Clone, PartialEq)]
pub struct PidDefinition {
    pub id: PidId,
    pub name: &'static str,
    pub unit: &'static str,
    pub group: PidGroup,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub default_value: f64,
    codec: Linear,
}

impl PidDefinition {
    /// SAE J1979 encoding: the bytes a vehicle reports for `value`.
    pub fn encode(&self, value: f64) -> Vec<u8> {
        self.codec.encode(value)
    }

    /// SAE J1979 decoding: what a scan tool shows for the reported bytes.
    pub fn decode(&self, bytes: &[u8]) -> f64 {
        self.codec.decode(bytes)
    }
}

#[derive(Clone, Copy)]
struct Range {
    min: f64,
    max: f64,
    step: f64,
    default_value: Option<f64>,
}

const fn range(min: f64, max: f64) -> Range {
    Range {
        min,
        max,
        step: 1.0,
        default_value: None,
    }
}

impl Range {
    const fn step(self, step: f64) -> Self {
        Self { step, ..self }
    }

    const fn default(self, default_value: f64) -> Self {
        Self {
            default_value: Some(default_value),
            ..self
        }
    }
}

const fn pid(
    id: &'static str,
    name: &'static str,
    unit: &'static str,
    group: PidGroup,
    range: Range,
    codec: Linear,
) -> PidDefinition {
    PidDefinition {
        id: PidId::from_static(id),
        name,
        unit,
        group,
        min: range.min,
        max: range.max,
        step: range.step,
        default_value: match range.default_value {
            Some(value) => value,
            None if range.min > 0.0 => range.min,
            None => 0.0,
        },
        codec,
    }
}

use PidGroup::{AirAndFuel, Emissions, Engine, SpeedAndDistance, Temperatures, Throttle};

/// The PIDs the official GUI exposes. Defaults match the official GUI's `defaults.xml`.
pub static PIDS: [PidDefinition; 45] = [
    pid(
        "010C",
        "Engine RPM",
        "rpm",
        Engine,
        range(0.0, 9999.0).default(1000.0),
        linear(Width::Two, 0.25, 0.0),
    ),
    pid(
        "0104",
        "Calculated engine load",
        "%",
        Engine,
        range(0.0, 100.0).default(50.0),
        PERCENT,
    ),
    pid(
        "0143",
        "Absolute load value",
        "%",
        Engine,
        range(0.0, 100.0).default(50.0),
        linear(Width::Two, 100.0 / 255.0, 0.0),
    ),
    pid(
        "010E",
        "Timing advance",
        "°",
        Engine,
        range(-64.0, 63.0),
        linear(Width::One, 0.5, -64.0),
    ),
    pid(
        "0161",
        "Driver's demand torque",
        "%",
        Engine,
        range(-125.0, 125.0).default(90.0),
        TORQUE_PERCENT,
    ),
    pid(
        "0162",
        "Actual engine torque",
        "%",
        Engine,
        range(-125.0, 125.0).default(50.0),
        TORQUE_PERCENT,
    ),
    pid(
        "0163",
        "Engine reference torque",
        "Nm",
        Engine,
        range(0.0, 65535.0).default(240.0),
        WORD,
    ),
    pid(
        "0142",
        "Control module voltage",
        "V",
        Engine,
        range(0.0, 65.0).step(0.1).default(14.0),
        linear(Width::Two, 0.001, 0.0),
    ),
    pid(
        "011F",
        "Run time since engine start",
        "s",
        Engine,
        range(0.0, 65535.0),
        WORD,
    ),
    pid(
        "010D",
        "Vehicle speed",
        "km/h",
        SpeedAndDistance,
        range(0.0, 255.0).default(50.0),
        PLAIN,
    ),
    pid(
        "0121",
        "Distance with MIL on",
        "km",
        SpeedAndDistance,
        range(0.0, 65535.0),
        WORD,
    ),
    pid(
        "0131",
        "Distance since codes cleared",
        "km",
        SpeedAndDistance,
        range(0.0, 65535.0),
        WORD,
    ),
    pid(
        "014D",
        "Time run with MIL on",
        "min",
        SpeedAndDistance,
        range(0.0, 65535.0),
        WORD,
    ),
    pid(
        "014E",
        "Time since codes cleared",
        "min",
        SpeedAndDistance,
        range(0.0, 65535.0),
        WORD,
    ),
    pid(
        "0130",
        "Warm-ups since codes cleared",
        "",
        SpeedAndDistance,
        range(0.0, 255.0),
        PLAIN,
    ),
    pid(
        "0111",
        "Throttle position",
        "%",
        Throttle,
        range(0.0, 100.0).default(20.0),
        PERCENT,
    ),
    pid(
        "0145",
        "Relative throttle position",
        "%",
        Throttle,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "0147",
        "Absolute throttle position B",
        "%",
        Throttle,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "0148",
        "Absolute throttle position C",
        "%",
        Throttle,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "0149",
        "Accelerator pedal position D",
        "%",
        Throttle,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "014A",
        "Accelerator pedal position E",
        "%",
        Throttle,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "014B",
        "Accelerator pedal position F",
        "%",
        Throttle,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "014C",
        "Commanded throttle actuator",
        "%",
        Throttle,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "015A",
        "Relative accelerator pedal position",
        "%",
        Throttle,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "010B",
        "Intake manifold pressure",
        "kPa",
        AirAndFuel,
        range(0.0, 255.0).default(100.0),
        PLAIN,
    ),
    pid(
        "0110",
        "MAF air flow rate",
        "g/s",
        AirAndFuel,
        range(0.0, 655.0).step(0.01).default(80.0),
        linear(Width::Two, 0.01, 0.0),
    ),
    pid(
        "0133",
        "Barometric pressure",
        "kPa",
        AirAndFuel,
        range(0.0, 255.0).default(101.0),
        PLAIN,
    ),
    pid(
        "010A",
        "Fuel pressure",
        "kPa",
        AirAndFuel,
        range(0.0, 765.0).step(3.0).default(150.0),
        linear(Width::One, 3.0, 0.0),
    ),
    pid(
        "0122",
        "Fuel rail pressure (relative)",
        "kPa",
        AirAndFuel,
        range(0.0, 5177.0).default(200.0),
        linear(Width::Two, 0.079, 0.0),
    ),
    pid(
        "0123",
        "Fuel rail gauge pressure",
        "kPa",
        AirAndFuel,
        range(0.0, 655350.0).step(10.0),
        linear(Width::Two, 10.0, 0.0),
    ),
    pid(
        "012F",
        "Fuel tank level",
        "%",
        AirAndFuel,
        range(0.0, 100.0).default(75.0),
        PERCENT,
    ),
    pid(
        "0152",
        "Ethanol fuel",
        "%",
        AirAndFuel,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "015D",
        "Fuel injection timing",
        "°",
        AirAndFuel,
        range(-210.0, 301.0),
        linear(Width::Two, 1.0 / 128.0, -210.0),
    ),
    pid(
        "015E",
        "Engine fuel rate",
        "L/h",
        AirAndFuel,
        range(0.0, 3212.0).step(0.05).default(20.0),
        linear(Width::Two, 0.05, 0.0),
    ),
    pid(
        "0105",
        "Engine coolant temperature",
        "°C",
        Temperatures,
        range(-40.0, 215.0).default(90.0),
        TEMPERATURE,
    ),
    pid(
        "010F",
        "Intake air temperature",
        "°C",
        Temperatures,
        range(-40.0, 215.0).default(20.0),
        TEMPERATURE,
    ),
    pid(
        "0146",
        "Ambient air temperature",
        "°C",
        Temperatures,
        range(-40.0, 215.0).default(25.0),
        TEMPERATURE,
    ),
    pid(
        "015C",
        "Engine oil temperature",
        "°C",
        Temperatures,
        range(-40.0, 210.0).default(95.0),
        TEMPERATURE,
    ),
    pid(
        "013C",
        "Catalyst temp. bank 1 sensor 1",
        "°C",
        Temperatures,
        range(-40.0, 6513.0),
        CATALYST_TEMPERATURE,
    ),
    pid(
        "013D",
        "Catalyst temp. bank 2 sensor 1",
        "°C",
        Temperatures,
        range(-40.0, 6513.0),
        CATALYST_TEMPERATURE,
    ),
    pid(
        "013E",
        "Catalyst temp. bank 1 sensor 2",
        "°C",
        Temperatures,
        range(-40.0, 6513.0),
        CATALYST_TEMPERATURE,
    ),
    pid(
        "013F",
        "Catalyst temp. bank 2 sensor 2",
        "°C",
        Temperatures,
        range(-40.0, 6513.0),
        CATALYST_TEMPERATURE,
    ),
    pid(
        "012C",
        "Commanded EGR",
        "%",
        Emissions,
        range(0.0, 100.0),
        PERCENT,
    ),
    pid(
        "012D",
        "EGR error",
        "%",
        Emissions,
        range(-100.0, 99.0),
        linear(Width::One, 100.0 / 128.0, -100.0),
    ),
    pid(
        "012E",
        "Commanded evaporative purge",
        "%",
        Emissions,
        range(0.0, 100.0),
        PERCENT,
    ),
];

pub fn find_pid(id: &str) -> Option<&'static PidDefinition> {
    PIDS.iter().find(|definition| definition.id.as_str() == id)
}

fn decimals(step: f64) -> i32 {
    if step.fract() == 0.0 {
        return 0;
    }
    js::number_to_string(step)
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len() as i32)
}

pub fn clamp_pid_value(definition: &PidDefinition, value: f64) -> f64 {
    let clamped = definition.min.max(value).min(definition.max);
    let snapped = js::math_round(clamped / definition.step) * definition.step;
    let factor = 10f64.powi(decimals(definition.step));
    (snapped * factor).round() / factor
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn encodes_values() {
        for (id, value, bytes) in [
            ("010C", 2000.0, vec![0x1f, 0x40]),
            ("0105", 90.0, vec![130]),
            ("010D", 50.0, vec![50]),
            ("0111", 100.0, vec![255]),
            ("0142", 14.2, vec![0x37, 0x78]),
            ("010E", -64.0, vec![0]),
        ] {
            assert_eq!(find_pid(id).unwrap().encode(value), bytes, "{id}={value}");
        }
    }

    #[test]
    fn decodes_what_it_encodes_to_within_one_step_of_resolution() {
        for p in &PIDS {
            for value in [p.min, p.default_value, p.max] {
                assert!(
                    (p.decode(&p.encode(value)) - value).abs() <= 0.5 + p.step,
                    "{}",
                    p.id
                );
            }
        }
    }

    #[test]
    fn snaps_values_to_the_pids_step_without_float_noise() {
        let voltage = find_pid("0142").unwrap();
        assert_eq!(clamp_pid_value(voltage, 14.23), 14.2);
        assert_eq!(clamp_pid_value(voltage, 99.0), 65.0);
    }

    #[test]
    fn has_unique_ids_and_defaults_inside_their_range() {
        let ids: HashSet<&str> = PIDS.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), PIDS.len());
        for p in &PIDS {
            assert_eq!(
                clamp_pid_value(p, p.default_value),
                p.default_value,
                "{}",
                p.id
            );
        }
    }

    #[test]
    fn catalog_ids_are_valid_pid_ids() {
        for p in &PIDS {
            assert!(PidId::new(p.id.as_str()).is_ok(), "{}", p.id);
        }
    }
}
