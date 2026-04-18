// See: docs/function-queries-spec.md §4, §9 (Plan C — combined shop shard)
// Related: docs/scoring-spec.md §5.1 (checkout-mode scoring → silent strip on HIGH)
use super::schema;
use promo_guard_shared::hash::hash_for_lookup;
use promo_guard_shared::normalize::address::{full_key, house_key, Address};
use promo_guard_shared::normalize::email::canonical_email;
use promo_guard_shared::normalize::phone::canonical_phone;
use promo_guard_shared::scoring::checkout::{
    score_checkout, CheckoutSignals, Decision, RedemptionHashSet,
};
use shopify_function::prelude::*;
use shopify_function::Result;

/// Placeholder percentage applied when scoring returns Allow/Review.
/// Real per-offer percentage is read from the offer config metafield; wiring
/// that up is a later task (see docs/function-queries-spec.md §1).
const PLACEHOLDER_PERCENTAGE: f64 = 10.0;

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    // Only act when the attached discount carries ORDER or PRODUCT class.
    // SHIPPING-only discounts route through the delivery-options target.
    let classes = input.discount().discount_classes();
    let has_order = classes.contains(&schema::DiscountClass::Order);
    let has_product = classes.contains(&schema::DiscountClass::Product);
    if !has_order && !has_product {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    }

    // ---------------------------------------------------------------------
    // 1. Pull the shop-wide shard. Missing/malformed → empty defaults
    //    (fail-open, identical to the Validation Function).
    // ---------------------------------------------------------------------
    let shop = input.shop();
    let shard = match shop.shard() {
        Some(mf) => parse_shard(mf.json_value()),
        None => Shard::default(),
    };
    let salt: &[u8] = &shard.salt;
    let default_cc: Option<&str> = shard.default_country_cc.as_deref();

    // ---------------------------------------------------------------------
    // 2. Build CheckoutSignals from the cart input.
    // ---------------------------------------------------------------------
    let cart = input.cart();
    let buyer_opt = cart.buyer_identity();

    let email_hash = buyer_opt
        .and_then(|b| b.email())
        .and_then(|raw| canonical_email(raw.as_str()))
        .map(|c| hash_for_lookup("email", c.as_bytes(), salt));

    let phone_hash = buyer_opt
        .and_then(|b| b.phone())
        .and_then(|raw| canonical_phone(raw.as_str(), default_cc))
        .map(|c| hash_for_lookup("phone", c.as_bytes(), salt));

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
        // MinHash sketches are skipped at checkout-time (wasm size budget).
        // Post-order scoring (scoring-spec §5.2) covers fuzzy matches.
        email_sketch: None,
        address_sketch: None,
        // The Discount Function only runs when its associated protected
        // discount is being evaluated — by definition the cart has a
        // guarded code.
        cart_has_guarded_code: true,
        customer_redeemed_tag,
    };

    // ---------------------------------------------------------------------
    // 3. Score and dispatch.
    // ---------------------------------------------------------------------
    let result = score_checkout(&signals, &shard.set);

    // HIGH (score >= 10) → silently withhold the discount.
    if matches!(result.decision, Decision::Block) {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    }

    // Allow / Review → emit the configured discount. MVP uses a placeholder
    // percentage; later we'll parse it out of the offer config metafield.
    let mut operations = Vec::new();

    if has_order {
        operations.push(schema::CartOperation::OrderDiscountsAdd(
            schema::OrderDiscountsAddOperation {
                selection_strategy: schema::OrderDiscountSelectionStrategy::First,
                candidates: vec![schema::OrderDiscountCandidate {
                    targets: vec![schema::OrderDiscountCandidateTarget::OrderSubtotal(
                        schema::OrderSubtotalTarget {
                            excluded_cart_line_ids: vec![],
                        },
                    )],
                    message: Some("Welcome offer".to_string()),
                    value: schema::OrderDiscountCandidateValue::Percentage(schema::Percentage {
                        value: Decimal(PLACEHOLDER_PERCENTAGE),
                    }),
                    conditions: None,
                    associated_discount_code: input
                        .triggering_discount_code()
                        .as_ref()
                        .map(|code| schema::AssociatedDiscountCode {
                            code: (*code).clone(),
                        }),
                }],
            },
        ));
    }

    Ok(schema::CartLinesDiscountsGenerateRunResult { operations })
}

// ---------------------------------------------------------------------------
// Shard parsing (mirrors the validator; see cart_validations_generate_run.rs).
// ---------------------------------------------------------------------------

#[derive(Default)]
pub(crate) struct Shard {
    pub(crate) salt: Vec<u8>,
    pub(crate) default_country_cc: Option<String>,
    pub(crate) set: RedemptionHashSet,
}

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

    fn empty_shards() -> RedemptionHashSet {
        RedemptionHashSet {
            email_hashes: vec![],
            phone_hashes: vec![],
            address_full_hashes: vec![],
            address_house_hashes: vec![],
            ip_hashes: vec![],
            device_hashes: vec![],
            email_sketches: vec![],
            address_sketches: vec![],
        }
    }

    fn base_signals() -> CheckoutSignals {
        CheckoutSignals {
            email_hash: None,
            phone_hash: None,
            address_full_hash: None,
            address_house_hash: None,
            ip_hash: None,
            device_hash: None,
            email_sketch: None,
            address_sketch: None,
            cart_has_guarded_code: true,
            customer_redeemed_tag: false,
        }
    }

    #[test]
    fn score_below_threshold_allows_discount() {
        let r = score_checkout(&base_signals(), &empty_shards());
        assert_eq!(r.score, 0);
        assert!(!matches!(r.decision, Decision::Block));
    }

    #[test]
    fn customer_tag_trips_block() {
        let mut s = base_signals();
        s.customer_redeemed_tag = true;
        let r = score_checkout(&s, &empty_shards());
        assert_eq!(r.score, 10);
        assert!(matches!(r.decision, Decision::Block));
    }

    #[test]
    fn phone_hash_match_trips_block() {
        let mut set = empty_shards();
        set.phone_hashes.push(0xdead_beef);
        let mut s = base_signals();
        s.phone_hash = Some(0xdead_beef);
        let r = score_checkout(&s, &set);
        assert!(matches!(r.decision, Decision::Block));
    }

    #[test]
    fn placeholder_percentage_is_ten() {
        assert_eq!(super::PLACEHOLDER_PERCENTAGE, 10.0);
    }

    #[test]
    fn parse_shard_reads_plan_c_fields() {
        use std::collections::BTreeMap;

        let mut m = BTreeMap::new();
        m.insert(
            "salt_hex".to_string(),
            JsonValue::String("deadbeef".into()),
        );
        m.insert(
            "phone_hashes".to_string(),
            JsonValue::Array(vec![JsonValue::String("a1b2c3d4".into())]),
        );
        let v = JsonValue::Object(m);
        let shard = super::parse_shard(&v);
        assert_eq!(shard.salt, vec![0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(shard.set.phone_hashes, vec![0xa1b2c3d4]);
    }
}
