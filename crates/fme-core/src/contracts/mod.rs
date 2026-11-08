//! Wire types, one module per `packages/contracts/src` file. Their JSON matches what the
//! TypeScript schemas encode with `Schema.toCodecJson`.

pub mod base_schemas;
pub mod emulator;
pub mod firmware;
pub mod presets;
pub mod reader;
pub mod rpc;
