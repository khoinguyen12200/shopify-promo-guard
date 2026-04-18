// See: docs/function-queries-spec.md §3, §9 (Plan C — single combined shard)
// Related: docs/scoring-spec.md §5.1, §10 (checkout decision → ValidationAdd)
use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

use promo_guard_shared::hash::hash_for_lookup;
use promo_guard_shared::normalize::address::{full_key, house_key, Address};
use promo_guard_shared::normalize::email::canonical_email;
use promo_guard_shared::normalize::phone::canonical_phone;
use promo_guard_shared::scoring::checkout::{
    score_checkout, CheckoutSignals, Decision, RedemptionHashSet,
};

#[shopify_function]
fn cart_validations_generate_run(
    input: schema::cart_validations_generate_run::Input,
) -> Result<schema::CartValidationsGenerateRunResult> {
    // ---------------------------------------------------------------------
    // 1. Pull the shard. Missing or malformed → empty defaults (fail-open).
    //    See: docs/function-queries-spec.md §9 (Plan C — single combined
    //    metafield; the per-offer key is substituted at deploy time).
    // ---------------------------------------------------------------------
    let shop = input.shop();
    let shard = match shop.shard() {
        Some(mf) => parse_shard(mf.json_value()),
        None => Shard::default(),
    };

    // ---------------------------------------------------------------------
    // 2. Build CheckoutSignals from the cart input.
    //    Every buyer field is optional per Shopify's schema (the buyer may
    //    not have typed an email yet, etc.). `None` means the rule is
    //    skipped inside score_checkout.
    // ---------------------------------------------------------------------
    let cart = input.cart();
    let buyer_opt = cart.buyer_identity();

    let salt: &[u8] = &shard.salt;
    let default_cc: Option<&str> = shard.default_country_cc.as_deref();

    let email_hash = buyer_opt
        .and_then(|b| b.email())
        .and_then(|raw| canonical_email(raw.as_str()))
        .map(|c| hash_for_lookup("email", c.as_bytes(), salt));

    let phone_hash = buyer_opt
        .and_then(|b| b.phone())
        .and_then(|raw| canonical_phone(raw.as_str(), default_cc))
        .map(|c| hash_for_lookup("phone", c.as_bytes(), salt));

    // Address — first delivery group with a usable address.
    // The typegen accessors return `Option<&String>`. `country_code` is
    // emitted as a String (ISO-2, e.g. "US") rather than an enum because
    // the Validation Function schema treats scalar enums as strings when
    // only referenced by value in an input query — verified against the
    // macro-expanded typegen output for this crate's schema.graphql.
    let addr_struct: Option<Address> = cart
        .delivery_groups()
        .iter()
        .find_map(|g| g.delivery_address())
        .map(|addr| Address {
            line1: addr.address_1().cloned().unwrap_or_default(),
            line2: addr.address_2().cloned().unwrap_or_default(),
            zip: addr.zip().cloned().unwrap_or_default(),
            country_code: addr.country_code().cloned().unwrap_or_default(),
        });

    let address_full_hash = addr_struct
        .as_ref()
        .map(|a| hash_for_lookup("address_full", full_key(a).as_bytes(), salt));
    let address_house_hash = addr_struct
        .as_ref()
        .map(|a| hash_for_lookup("address_house", house_key(a).as_bytes(), salt));

    let customer_redeemed_tag = buyer_opt
        .and_then(|b| b.customer())
        .map(|c| *c.has_any_tag())
        .unwrap_or(false);

    let signals = CheckoutSignals {
        email_hash,
        phone_hash,
        address_full_hash,
        address_house_hash,
        ip_hash: None,
        device_hash: None,
        // MinHash sketches are not fed into the checkout-time scorer in
        // v1: trigram + sketch computation would push the wasm over its
        // size budget. Post-order scoring (scoring-spec §5.2) covers
        // fuzzy matches.
        email_sketch: None,
        address_sketch: None,
        // Plan C gates at deployment time — one validator per offer —
        // so by definition this cart is subject to this offer's rules.
        // The empty-ledger fast path inside score_checkout still returns
        // Allow when there are no prior redemptions to compare against.
        cart_has_guarded_code: true,
        customer_redeemed_tag,
    };

    // ---------------------------------------------------------------------
    // 3. Score and translate Decision → ValidationError list.
    //    Per scoring-spec §5.1: only HIGH blocks at checkout. MEDIUM
    //    (Review) and ALLOW both pass through unchanged.
    // ---------------------------------------------------------------------
    let result = score_checkout(&signals, &shard.set);
    let errors = match result.decision {
        Decision::Block => vec![schema::ValidationError {
            message: "This offer has already been used.".to_owned(),
            target: "$.cart".to_owned(),
        }],
        _ => vec![],
    };

    Ok(schema::CartValidationsGenerateRunResult {
        operations: vec![schema::Operation::ValidationAdd(
            schema::ValidationAddOperation { errors },
        )],
    })
}

// ---------------------------------------------------------------------------
// Shard parsing (kept here so the scoring crate stays I/O-free).
// ---------------------------------------------------------------------------

/// Parsed view of the per-offer shard metafield. All fields are optional:
/// a missing or malformed shard becomes `Shard::default()` and scoring
/// proceeds against an empty ledger (→ Allow).
#[derive(Default)]
pub(crate) struct Shard {
    pub(crate) salt: Vec<u8>,
    pub(crate) default_country_cc: Option<String>,
    pub(crate) set: RedemptionHashSet,
}

/// Parse the combined shard JSON.
///
/// Expected shape (from docs/function-queries-spec.md §9, Plan C):
///
/// ```json
/// {
///   "v": 1,
///   "salt_hex": "deadbeef...",
///   "default_country_cc": "+84",
///   "phone_hashes":         ["a1b2c3d4", ...],
///   "email_hashes":         ["..."],
///   "address_full_hashes":  ["..."],
///   "address_house_hashes": ["..."],
///   "ip_hashes":            ["..."],
///   "device_hashes":        ["..."],
///   "email_sketches":       ["1a2b3c4d000000017fffffffffffffff", ...],
///   "address_sketches":     ["..."]
/// }
/// ```
///
/// Any missing field defaults to empty / `None`. Any malformed hex entry
/// is silently dropped per-entry (not per-shard) so one corrupt row
/// cannot take the shop offline.
pub(crate) fn parse_shard(v: &JsonValue) -> Shard {
    let JsonValue::Object(map) = v else {
        return Shard::default();
    };

    let salt = map
        .get("salt_hex")
        .and_then(string_of)
        .map(|s| hex_to_bytes(&s))
        .unwrap_or_default();

    let default_country_cc = map.get("default_country_cc").and_then(string_of);

    let set = RedemptionHashSet {
        phone_hashes: hash_array(map.get("phone_hashes")),
        email_hashes: hash_array(map.get("email_hashes")),
        address_full_hashes: hash_array(map.get("address_full_hashes")),
        address_house_hashes: hash_array(map.get("address_house_hashes")),
        ip_hashes: hash_array(map.get("ip_hashes")),
        device_hashes: hash_array(map.get("device_hashes")),
        email_sketches: sketch_array(map.get("email_sketches")),
        address_sketches: sketch_array(map.get("address_sketches")),
    };

    Shard {
        salt,
        default_country_cc,
        set,
    }
}

fn string_of(v: &JsonValue) -> Option<String> {
    if let JsonValue::String(s) = v {
        Some(s.clone())
    } else {
        None
    }
}

fn hash_array(v: Option<&JsonValue>) -> Vec<u32> {
    let Some(JsonValue::Array(items)) = v else {
        return vec![];
    };
    items
        .iter()
        .filter_map(string_of)
        .filter_map(|s| u32::from_str_radix(&s, 16).ok())
        .collect()
}

fn sketch_array(v: Option<&JsonValue>) -> Vec<[u32; 4]> {
    let Some(JsonValue::Array(items)) = v else {
        return vec![];
    };
    items
        .iter()
        .filter_map(string_of)
        .filter_map(|s| parse_sketch(&s))
        .collect()
}

fn parse_sketch(s: &str) -> Option<[u32; 4]> {
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u32; 4];
    for (i, slot) in out.iter_mut().enumerate() {
        let chunk = &s[i * 8..(i + 1) * 8];
        *slot = u32::from_str_radix(chunk, 16).ok()?;
    }
    Some(out)
}

fn hex_to_bytes(s: &str) -> Vec<u8> {
    if s.len() % 2 != 0 {
        return vec![];
    }
    (0..s.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn json_obj(pairs: &[(&str, JsonValue)]) -> JsonValue {
        let mut m = BTreeMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        JsonValue::Object(m)
    }

    fn json_str_array(xs: &[&str]) -> JsonValue {
        JsonValue::Array(
            xs.iter()
                .map(|s| JsonValue::String((*s).to_string()))
                .collect(),
        )
    }

    #[test]
    fn parse_shard_handles_non_object() {
        let shard = super::parse_shard(&JsonValue::Null);
        assert!(shard.salt.is_empty());
        assert!(shard.default_country_cc.is_none());
        assert!(shard.set.phone_hashes.is_empty());
    }

    #[test]
    fn parse_shard_reads_known_fields() {
        let v = json_obj(&[
            ("salt_hex", JsonValue::String("deadbeef".into())),
            ("default_country_cc", JsonValue::String("+84".into())),
            ("phone_hashes", json_str_array(&["a1b2c3d4", "ffffffff"])),
            (
                "email_sketches",
                json_str_array(&["1a2b3c4d000000017fffffffffffffff"]),
            ),
            // Malformed entries get silently dropped per-row.
            ("email_hashes", json_str_array(&["zzzz", "00000001"])),
        ]);
        let shard = super::parse_shard(&v);
        assert_eq!(shard.salt, vec![0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(shard.default_country_cc.as_deref(), Some("+84"));
        assert_eq!(shard.set.phone_hashes, vec![0xa1b2c3d4, 0xffffffff]);
        assert_eq!(shard.set.email_hashes, vec![0x00000001]);
        assert_eq!(shard.set.email_sketches.len(), 1);
        assert_eq!(shard.set.email_sketches[0][0], 0x1a2b3c4d);
    }

    #[test]
    fn parse_sketch_rejects_wrong_length() {
        assert!(super::parse_sketch("short").is_none());
        assert!(super::parse_sketch(&"f".repeat(33)).is_none());
    }

    #[test]
    fn hex_to_bytes_is_lenient() {
        assert_eq!(super::hex_to_bytes("00ff"), vec![0x00, 0xff]);
        // Odd length → empty (rather than partial).
        assert_eq!(super::hex_to_bytes("abc"), Vec::<u8>::new());
    }

    // -----------------------------------------------------------------
    // End-to-end via run_function_with_input.
    // -----------------------------------------------------------------

    fn run(payload: &str) -> schema::CartValidationsGenerateRunResult {
        shopify_function::run_function_with_input(super::cart_validations_generate_run, payload)
            .expect("run_function_with_input")
    }

    fn validation_errors(
        r: &schema::CartValidationsGenerateRunResult,
    ) -> &[schema::ValidationError] {
        match r.operations.first().expect("exactly one operation") {
            schema::Operation::ValidationAdd(op) => &op.errors,
        }
    }

    #[test]
    fn empty_shard_allows_checkout() {
        let payload = r#"{
            "cart": {
                "buyerIdentity": {
                    "email": "new@example.com",
                    "phone": "+14155551212",
                    "customer": { "hasAnyTag": false }
                },
                "deliveryGroups": []
            },
            "shop": { "shard": null }
        }"#;
        let r = run(payload);
        assert_eq!(r.operations.len(), 1);
        assert!(validation_errors(&r).is_empty(), "allow when shard is null");
    }

    #[test]
    fn customer_tag_blocks_checkout() {
        // Even with no shard data, the customer-tag rule alone tips into
        // HIGH (W_CUSTOMER_TAG = 10 per scoring-spec §4.7).
        let payload = r#"{
            "cart": {
                "buyerIdentity": {
                    "email": null,
                    "phone": null,
                    "customer": { "hasAnyTag": true }
                },
                "deliveryGroups": []
            },
            "shop": {
                "shard": { "jsonValue": { "v": 1 } }
            }
        }"#;
        let r = run(payload);
        let errs = validation_errors(&r);
        assert_eq!(errs.len(), 1, "tag match → one ValidationError");
        assert_eq!(errs[0].target, "$.cart");
    }

    #[test]
    fn phone_match_in_shard_blocks_checkout() {
        // Compute the expected hash exactly the way the function will so
        // this test stays wired to the real normalize + hash pipeline.
        let salt: Vec<u8> = vec![0xde, 0xad, 0xbe, 0xef];
        let canonical =
            promo_guard_shared::normalize::phone::canonical_phone("+14155551212", None)
                .expect("canonical phone");
        let h = promo_guard_shared::hash::hash_for_lookup(
            "phone",
            canonical.as_bytes(),
            &salt,
        );
        let hex = promo_guard_shared::hash::hash_to_hex(h);
        let payload = format!(
            r#"{{
                "cart": {{
                    "buyerIdentity": {{
                        "email": null,
                        "phone": "+14155551212",
                        "customer": null
                    }},
                    "deliveryGroups": []
                }},
                "shop": {{
                    "shard": {{
                        "jsonValue": {{
                            "v": 1,
                            "salt_hex": "deadbeef",
                            "phone_hashes": ["{}"]
                        }}
                    }}
                }}
            }}"#,
            hex
        );
        let r = run(&payload);
        let errs = validation_errors(&r);
        assert_eq!(errs.len(), 1, "phone match → one ValidationError");
    }

    #[test]
    fn phone_miss_allows_checkout() {
        // Shard has a random phone that won't match the buyer's.
        let payload = r#"{
            "cart": {
                "buyerIdentity": {
                    "email": null,
                    "phone": "+14155551212",
                    "customer": null
                },
                "deliveryGroups": []
            },
            "shop": {
                "shard": {
                    "jsonValue": {
                        "v": 1,
                        "salt_hex": "deadbeef",
                        "phone_hashes": ["aaaaaaaa"]
                    }
                }
            }
        }"#;
        let r = run(payload);
        assert!(validation_errors(&r).is_empty());
    }
}
