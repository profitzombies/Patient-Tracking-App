/**
 * Static image map for THINNR products. Metro requires literal require()
 * calls, so entries are enumerated by hand and keyed by catalog product id.
 * Renders were downloaded from the matching getthinnr.com product pages.
 */
import type { ImageSourcePropType } from 'react-native';

export const PRODUCT_IMAGES: Record<string, ImageSourcePropType> = {
  prod1: require('@/assets/images/products/protocol.jpg'),
  prod2: require('@/assets/images/products/boost.jpg'),
  prod3: require('@/assets/images/products/control.jpg'),
  prod4: require('@/assets/images/products/detox.jpg'),
  prod5: require('@/assets/images/products/regulate.jpg'),
  prod6: require('@/assets/images/products/b-active.jpg'),
  prod7: require('@/assets/images/products/creatine-plus.jpg'),
  prod8: require('@/assets/images/products/fiber.jpg'),
  prod9: require('@/assets/images/products/maintenance-stack.jpg'),
};
