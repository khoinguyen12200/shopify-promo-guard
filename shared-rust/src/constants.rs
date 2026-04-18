//! Versioning and salt format constants.
//!
//! See: docs/normalization-spec.md §7 (salt handling), §11 (version markers)

/// Normalization-rule version. Bump when any rule in
/// docs/normalization-spec.md changes; fixture file must be rebuilt.
pub const NORMALIZATION_VERSION: u32 = 1;

/// Length of Shop.salt in bytes (pre-hex encoding).
pub const SHOP_SALT_BYTES: usize = 32;

/// FNV-1a 32-bit offset basis.
pub const FNV_OFFSET_BASIS_32: u32 = 0x811c9dc5;

/// FNV-1a 32-bit prime.
pub const FNV_PRIME_32: u32 = 0x01000193;

/// Separator byte between salt, tag, and value when hashing.
pub const HASH_SEP: u8 = 0x00;
