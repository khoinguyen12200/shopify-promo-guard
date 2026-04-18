//! Promo Guard shared library — single source of truth for normalize + hash + scoring.
//!
//! See: docs/build-orchestration-spec.md §5
//! Related: docs/normalization-spec.md §11 (versioning)

#![forbid(unsafe_code)]

pub mod constants;
pub mod hash; // populated in T06
pub mod normalize; // populated in T07–T09
pub mod scoring; // populated in T11, T13

// Stub modules — empty pub mods so the crate compiles before later tasks fill them.
