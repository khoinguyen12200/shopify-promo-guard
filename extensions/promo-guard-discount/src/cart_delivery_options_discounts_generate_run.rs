// See: docs/function-queries-spec.md §4 (cart.delivery-options.discounts.generate.run)
// Related: docs/function-queries-spec.md §10 (Non-goals — delivery target deferred)
//
// Promo Guard MVP only guards order/product welcome discounts. The delivery
// target is wired so the extension keeps both `[[extensions.targeting]]`
// blocks compilable, but it is intentionally a no-op: it always returns
// `{ operations: [] }`. Free-shipping welcome offers are out of scope until
// merchants ask for them.
use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

#[shopify_function]
fn cart_delivery_options_discounts_generate_run(
    _input: schema::cart_delivery_options_discounts_generate_run::Input,
) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] })
}
