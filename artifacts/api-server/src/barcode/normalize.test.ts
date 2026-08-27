/**
 * Pure normalization tests: canonical barcode forms and the Open Food Facts
 * record → per-serving facts mapping (labeled serving preferred, per-100
 * values scaled only when the serving's unit verifiably matches the basis
 * unit, honest "100 g"/"100 ml" fallback, null for anything incomplete).
 */
import { describe, expect, it } from "vitest";
import { normalizeBarcode, normalizeOffProduct } from "./normalize";

describe("normalizeBarcode", () => {
  it("keeps EAN-13 codes as-is", () => {
    expect(normalizeBarcode("3017624010701")).toBe("3017624010701");
  });

  it("keeps EAN-8 codes as-is", () => {
    expect(normalizeBarcode("20724696")).toBe("20724696");
  });

  it("zero-pads UPC-A to its GTIN-13 form", () => {
    expect(normalizeBarcode("038000138416")).toBe("0038000138416");
  });

  it("drops the leading zero of a GTIN-14", () => {
    expect(normalizeBarcode("00038000138416")).toBe("0038000138416");
  });

  it("tolerates spaces and hyphens", () => {
    expect(normalizeBarcode(" 3 017624 010701 ")).toBe("3017624010701");
    expect(normalizeBarcode("0-38000-13841-6")).toBe("0038000138416");
  });

  it("rejects everything that is not a UPC/EAN style code", () => {
    expect(normalizeBarcode("")).toBeNull();
    expect(normalizeBarcode("30176ABC10701")).toBeNull();
    expect(normalizeBarcode("1234567")).toBeNull(); // 7 digits
    expect(normalizeBarcode("12345678901")).toBeNull(); // 11 digits
    expect(normalizeBarcode("123456789012345")).toBeNull(); // 15 digits
    expect(normalizeBarcode("40038000138416")).toBeNull(); // 14, no leading 0
    expect(normalizeBarcode("0000000000000")).toBeNull(); // all zeros
  });
});

const NUTELLA = {
  product_name: "Nutella",
  brands: "Ferrero,Nutella",
  serving_size: "15 g",
  serving_quantity: 15,
  nutriments: {
    "energy-kcal_serving": 80.4,
    proteins_serving: 0.96,
    carbohydrates_serving: 8.6,
    fat_serving: 4.74,
    "energy-kcal_100g": 536,
    proteins_100g: 6.4,
    carbohydrates_100g: 57.5,
    fat_100g: 31.6,
  },
};

describe("normalizeOffProduct", () => {
  it("prefers the labeled per-serving basis and rounds to app precision", () => {
    expect(normalizeOffProduct(NUTELLA)).toEqual({
      name: "Nutella",
      brand: "Ferrero",
      serving: "15 g",
      calories: 80,
      protein: 1,
      carbs: 8.6,
      fat: 4.7,
    });
  });

  it("labels a per-serving basis without a printed size as one serving", () => {
    const product = {
      product_name: "Protein Bar",
      nutriments: {
        "energy-kcal_serving": 210,
        proteins_serving: 20,
        carbohydrates_serving: 22,
        fat_serving: 7,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Protein Bar",
      serving: "1 serving",
      calories: 210,
      protein: 20,
      carbs: 22,
      fat: 7,
    });
  });

  it("scales per-100g values to the labeled serving when that is all it has", () => {
    const product = {
      product_name: "Corn Flakes",
      brands: "Kellogg's",
      serving_size: "30 g",
      serving_quantity: 30,
      nutriments: {
        "energy-kcal_100g": 380,
        proteins_100g: 7,
        carbohydrates_100g: 84,
        fat_100g: 0.9,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Corn Flakes",
      brand: "Kellogg's",
      serving: "30 g",
      calories: 114,
      protein: 2.1,
      carbs: 25.2,
      fat: 0.3,
    });
  });

  it("falls back to an honest 100 g serving when no serving line is printed", () => {
    const product = {
      product_name: "Rolled Oats",
      nutriments: {
        "energy-kcal_100g": 372,
        proteins_100g: 13.5,
        carbohydrates_100g: 58.7,
        fat_100g: 7,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Rolled Oats",
      serving: "100 g",
      calories: 372,
      protein: 13.5,
      carbs: 58.7,
      fat: 7,
    });
  });

  it("accepts numeric strings the way Open Food Facts sometimes stores them", () => {
    const product = {
      product_name: "Sparkling Water",
      serving_size: "330 ml",
      serving_quantity: "330",
      nutrition_data_per: "100ml",
      nutriments: {
        "energy-kcal_100g": "0",
        proteins_100g: "0",
        carbohydrates_100g: "0",
        fat_100g: "0",
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Sparkling Water",
      serving: "330 ml",
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
    });
  });

  it("scales a per-100ml basis to a milliliter serving (units match)", () => {
    const product = {
      product_name: "Cola",
      serving_size: "330 ml",
      serving_quantity: 330,
      serving_quantity_unit: "ml",
      nutrition_data_per: "100ml",
      nutriments: {
        "energy-kcal_100g": 42,
        proteins_100g: 0,
        carbohydrates_100g: 10.6,
        fat_100g: 0,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Cola",
      serving: "330 ml",
      calories: 139,
      protein: 0,
      carbs: 35,
      fat: 0,
    });
  });

  it("never treats a milliliter serving as grams against a per-100g basis", () => {
    // The reviewer case: an ml serving with only per-100g values must NOT be
    // scaled by density guesswork — the honest per-100g panel is the answer.
    const product = {
      product_name: "Oat Drink",
      serving_size: "330 ml",
      serving_quantity: 330,
      serving_quantity_unit: "ml",
      nutrition_data_per: "100g",
      nutriments: {
        "energy-kcal_100g": 45,
        proteins_100g: 1,
        carbohydrates_100g: 6.6,
        fat_100g: 1.5,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Oat Drink",
      serving: "100 g",
      calories: 45,
      protein: 1,
      carbs: 6.6,
      fat: 1.5,
    });
  });

  it("labels an unscaled per-100ml basis as 100 ml, not 100 g", () => {
    const product = {
      product_name: "Iced Tea",
      nutrition_data_per: "100ml",
      nutriments: {
        "energy-kcal_100g": 19,
        proteins_100g: 0,
        carbohydrates_100g: 4.7,
        fat_100g: 0,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Iced Tea",
      serving: "100 ml",
      calories: 19,
      protein: 0,
      carbs: 4.7,
      fat: 0,
    });
  });

  it("does not scale count-style servings whose unit cannot be verified", () => {
    const product = {
      product_name: "Butter Cookies",
      serving_size: "2 cookies",
      serving_quantity: 28,
      nutriments: {
        "energy-kcal_100g": 500,
        proteins_100g: 5,
        carbohydrates_100g: 62,
        fat_100g: 25,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Butter Cookies",
      serving: "100 g",
      calories: 500,
      protein: 5,
      carbs: 62,
      fat: 25,
    });
  });

  it("does not scale foreign serving units like oz", () => {
    const product = {
      product_name: "Trail Mix",
      serving_size: "1 oz",
      serving_quantity: 1,
      serving_quantity_unit: "oz",
      nutriments: {
        "energy-kcal_100g": 480,
        proteins_100g: 14,
        carbohydrates_100g: 45,
        fat_100g: 28,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Trail Mix",
      serving: "100 g",
      calories: 480,
      protein: 14,
      carbs: 45,
      fat: 28,
    });
  });

  it("does not scale when the label amount disagrees with the parsed quantity", () => {
    // Label says 25 g but OFF parsed 250 — the label proves nothing about
    // what serving_quantity counts, so no scaling.
    const product = {
      product_name: "Muesli",
      serving_size: "25 g",
      serving_quantity: 250,
      nutriments: {
        "energy-kcal_100g": 360,
        proteins_100g: 9,
        carbohydrates_100g: 62,
        fat_100g: 6,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Muesli",
      serving: "100 g",
      calories: 360,
      protein: 9,
      carbs: 62,
      fat: 6,
    });
  });

  it("still scales a gram serving read off the label with a per-100g basis", () => {
    const product = {
      product_name: "Dark Chocolate",
      serving_size: "4 squares (25g)",
      serving_quantity: 25,
      nutriments: {
        "energy-kcal_100g": 560,
        proteins_100g: 7.8,
        carbohydrates_100g: 46,
        fat_100g: 38,
      },
    };
    expect(normalizeOffProduct(product)).toEqual({
      name: "Dark Chocolate",
      brand: undefined,
      serving: "4 squares (25g)",
      calories: 140,
      protein: 2,
      carbs: 11.5,
      fat: 9.5,
    });
  });

  it("returns null when any macro is missing rather than inventing a zero", () => {
    const product = {
      product_name: "Mystery Snack",
      nutriments: {
        "energy-kcal_100g": 500,
        proteins_100g: 5,
        carbohydrates_100g: 60,
        // fat missing on both bases
      },
    };
    expect(normalizeOffProduct(product)).toBeNull();
  });

  it("returns null without a product name or nutriments", () => {
    expect(normalizeOffProduct(null)).toBeNull();
    expect(normalizeOffProduct({})).toBeNull();
    expect(normalizeOffProduct({ product_name: "  " , nutriments: {} })).toBeNull();
    expect(normalizeOffProduct({ product_name: "Named", nutriments: {} })).toBeNull();
    expect(normalizeOffProduct({ product_name: "No Panel" })).toBeNull();
  });

  it("rejects junk community data instead of caching it", () => {
    const product = {
      product_name: "Broken Row",
      nutriments: {
        "energy-kcal_serving": 100000,
        proteins_serving: 1,
        carbohydrates_serving: 1,
        fat_serving: 1,
      },
    };
    expect(normalizeOffProduct(product)).toBeNull();
  });

  it("keeps only the first brand and drops an empty brands field", () => {
    const withEmptyBrand = normalizeOffProduct({ ...NUTELLA, brands: "  " });
    expect(withEmptyBrand).not.toBeNull();
    expect(withEmptyBrand && "brand" in withEmptyBrand).toBe(false);
  });
});
