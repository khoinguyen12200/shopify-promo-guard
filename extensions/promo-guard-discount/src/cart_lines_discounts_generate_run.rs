// See: docs/function-queries-spec.md §4 (Discount Function input query + output)
// Related: docs/scoring-spec.md §5.1 (checkout-mode scoring → silent strip on HIGH)
use super::schema;
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

    // Build CheckoutSignals from the input. Real hashing (phone/email/address)
    // requires the offer config metafield (for the shop salt) and shared-rust
    // normalize/hash helpers. Wiring those inside the query budget is deferred;
    // for now we ship with the customer-tag rule which is enough to flip HIGH
    // on confirmed redeemers while the hashing path lands later.
    //
    // See: docs/scoring-spec.md §4.7 (customer tag rule — weight 10 = HIGH).
    let customer_redeemed_tag = match input.cart().buyer_identity() {
        Some(bi) => match bi.customer() {
            Some(customer) => *customer.has_any_tag(),
            None => false,
        },
        None => false,
    };

    let signals = CheckoutSignals {
        email_hash: None,
        phone_hash: None,
        address_full_hash: None,
        address_house_hash: None,
        ip_hash: None,
        device_hash: None,
        email_sketch: None,
        address_sketch: None,
        // The Discount Function only runs when its associated protected
        // discount is being evaluated. Per scoring-spec.md §5.1 the fast-path
        // guard is "cart has our guarded code" — here that is implicit.
        cart_has_guarded_code: true,
        customer_redeemed_tag,
    };

    // Ledger shards are parsed lazily when real hashing is wired in.
    // Empty sets are safe per scoring-spec.md §8 (missing shards = Allow).
    let shards = RedemptionHashSet {
        email_hashes: vec![],
        phone_hashes: vec![],
        address_full_hashes: vec![],
        address_house_hashes: vec![],
        ip_hashes: vec![],
        device_hashes: vec![],
        email_sketches: vec![],
        address_sketches: vec![],
    };

    let result = score_checkout(&signals, &shards);

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

#[cfg(test)]
mod tests {
    use promo_guard_shared::scoring::checkout::{
        score_checkout, CheckoutSignals, Decision, RedemptionHashSet,
    };

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
    fn placeholder_percentage_is_ten() {
        assert_eq!(super::PLACEHOLDER_PERCENTAGE, 10.0);
    }
}
