/**
 * Node stand-in for data/product-images.ts: the real module require()s
 * binary .jpg assets Metro resolves, which tsx cannot load. The coach screen
 * (rendered by the coach-paused section) pulls it in via the product card.
 */
export const PRODUCT_IMAGES: Record<string, { uri: string }> = {};
