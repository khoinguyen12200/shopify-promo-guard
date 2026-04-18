import '@shopify/ui-extensions';

// @ts-expect-error — module path resolves at build time via Shopify CLI.
declare module './src/BlockExtension.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
