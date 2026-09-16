/**
 * Product-page content for the HQ demo catalog. Generated from the product
 * pages migration (which copies the program catalog verbatim); keep in sync by
 * re-running the generator in the task notes rather than editing by hand.
 */
import type { ProductPageContent } from '@/lib/billing-types';

export const DEMO_PRODUCT_PAGES: Record<string, ProductPageContent & { description: string }> = {
  "control": {
    "category": "supplement",
    "tagline": "Metabolic & Appetite Support",
    "format": "Dietary Supplement · 60 Vegetarian Capsules",
    "how_to_take": "Take as directed on the label and by your THINNR provider.",
    "facts_title": "Key Ingredients",
    "disclaimer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.",
    "benefits": [
      "Helps support healthy appetite**",
      "Helps support healthy metabolic function**",
      "Helps support healthy blood sugar levels already within normal range**",
      "Helps support healthy energy levels**"
    ],
    "facts": [
      {
        "name": "African Mango",
        "detail": "Helps support healthy appetite and metabolic function.**"
      },
      {
        "name": "Raspberry Ketones",
        "detail": "Helps support healthy metabolic function.**"
      },
      {
        "name": "Green Coffee Bean Extract",
        "detail": "Rich in chlorogenic acids to help support healthy glucose metabolism.**"
      },
      {
        "name": "Green Tea Extract",
        "detail": "Contains catechins and caffeine to help support healthy energy levels.**"
      }
    ],
    "faqs": [
      {
        "question": "Where can I get Control?",
        "answer": "Available through certified THINNR healthcare providers."
      },
      {
        "question": "Has the FDA evaluated these statements?",
        "answer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."
      }
    ],
    "description": "Thinnr Control helps support healthy appetite and metabolic function through a blend of natural ingredients including African Mango, Raspberry Ketones, Green Coffee Bean, and Green Tea.**"
  },
  "regulate": {
    "category": "supplement",
    "tagline": "Glucose Stabilization & Metabolic Support",
    "format": "Dietary Supplement · 60 Vegetarian Capsules",
    "how_to_take": "Take as directed on the label and by your THINNR provider.",
    "facts_title": "Key Ingredients",
    "disclaimer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.",
    "benefits": [
      "Helps support healthy metabolic function*",
      "Helps support healthy blood sugar levels already within normal range*",
      "Helps support digestive wellness*",
      "Helps support a healthy gut microbiome**"
    ],
    "facts": [
      {
        "name": "Berberine",
        "detail": "Helps support healthy glucose levels and metabolic function.**"
      },
      {
        "name": "Bitter Melon",
        "detail": "Helps support healthy metabolic function and digestive wellness.**"
      },
      {
        "name": "Banaba Leaf",
        "detail": "Contains corosolic acid that may help support healthy glucose metabolism.**"
      }
    ],
    "faqs": [
      {
        "question": "Where can I get Regulate?",
        "answer": "Available through certified THINNR healthcare providers."
      },
      {
        "question": "Has the FDA evaluated these statements?",
        "answer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."
      }
    ],
    "description": "Thinnr Regulate helps support healthy glucose levels and metabolic function with Berberine, Bitter Melon, and Banaba Leaf.**"
  },
  "detox": {
    "category": "supplement",
    "tagline": "Liver & Kidney Support",
    "format": "Dietary Supplement · 90 Vegetarian Capsules",
    "how_to_take": "Take as directed on the label and by your THINNR provider.",
    "facts_title": "Key Ingredients",
    "disclaimer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.",
    "benefits": [
      "Helps support cellular energy and liver health*",
      "Helps support healthy bile function and digestion*",
      "Helps support healthy fluid balance*",
      "Helps provide antioxidant support for liver health*",
      "Helps support protein and fat digestion with digestive enzymes*"
    ],
    "facts": [
      {
        "name": "Solarplast®",
        "detail": "Proprietary chloroplast complex from spinach that helps support cellular energy and liver health.**"
      },
      {
        "name": "Artichoke Leaf",
        "detail": "Helps support healthy bile function and digestive wellness.**"
      },
      {
        "name": "Dandelion Leaf",
        "detail": "Helps support healthy fluid balance and the body's natural processes.**"
      },
      {
        "name": "Milk Thistle",
        "detail": "Contains silymarin that helps provide antioxidant support for liver health.**"
      },
      {
        "name": "Protease SP",
        "detail": "Digestive enzyme that helps support protein digestion.**"
      },
      {
        "name": "Lipase",
        "detail": "Helps support fat digestion and nutrient absorption.**"
      }
    ],
    "faqs": [
      {
        "question": "Where can I get Detox?",
        "answer": "Available through certified THINNR healthcare providers."
      },
      {
        "question": "Has the FDA evaluated these statements?",
        "answer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."
      }
    ],
    "description": "Thinnr Detox helps support your body's natural detoxification processes. This formula helps support liver health and digestive wellness.**"
  },
  "fiber": {
    "category": "supplement",
    "tagline": "Plant-Based Colon & Digestive Support",
    "format": "Dietary Supplement · 120 Capsules · Psyllium-Based Formula",
    "how_to_take": "Take as directed on the label and by your THINNR provider.",
    "facts_title": "Key Ingredient",
    "disclaimer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.",
    "benefits": [
      "Free from artificial sweeteners, sugar, and harmful chemicals**",
      "Psyllium is resistant to fermentation, helping to support digestive comfort**",
      "Helps support digestive regularity and comfort**",
      "Helps support healthy cholesterol levels already within normal range**",
      "Helps support colon health as part of a healthy diet**"
    ],
    "facts": [
      {
        "name": "Psyllium (Plantago ovata)",
        "detail": "Derived from the Plantago ovata plant, psyllium is renowned for its effectiveness in increasing stool bulk and softening, making it easier to pass without the harsh side effects often associated with synthetic laxatives."
      }
    ],
    "faqs": [
      {
        "question": "When should I start a fiber supplement?",
        "answer": "If the patient has a pre-existing history of constipation, it is recommended that they start taking a sugar-free fiber supplement beginning on the first day of the Thinnr Metabolic Thinning Phase."
      },
      {
        "question": "Where can I get Fiber?",
        "answer": "Available through certified THINNR healthcare providers."
      },
      {
        "question": "Has the FDA evaluated these statements?",
        "answer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."
      }
    ],
    "description": "A superior dietary supplement designed to naturally soothe and regulate your digestive system. Its primary ingredient, derived from the Plantago ovata plant, offers a gentle yet effective solution for digestive health."
  },
  "creatine-plus": {
    "category": "supplement",
    "tagline": "Powerful Muscle & Mind Support",
    "format": "Dietary Supplement · 480 Grams · 5g Creatine + 3g HMB Formula",
    "how_to_take": "Take 1 serving daily (5g Creatine Monohydrate + 3g HMB). Can be mixed into water, shakes, or your favorite beverage.",
    "facts_title": "Supplement Facts · Per Serving",
    "disclaimer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.",
    "benefits": [
      "Creatine helps support ATP production, while HMB helps support muscle maintenance**",
      "Creatine helps support brain energy metabolism and cognitive function**",
      "HMB helps support lean mass during weight management programs**",
      "Together, these compounds help support post-workout recovery**",
      "Helps support muscle maintenance for those transitioning off weight management programs**"
    ],
    "facts": [
      {
        "name": "Creatine Monohydrate",
        "detail": "5 g — helps support lean muscle maintenance, energy during workouts, and cognitive function.**"
      },
      {
        "name": "HMB (β-Hydroxy β-Methylbutyrate)",
        "detail": "3 g — helps support muscle maintenance, recovery, and strength during calorie restriction.**"
      }
    ],
    "faqs": [
      {
        "question": "Where can I get Creatine+?",
        "answer": "Available through certified THINNR healthcare providers."
      },
      {
        "question": "Has the FDA evaluated these statements?",
        "answer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."
      }
    ],
    "description": "A formula that combines two ingredients to help support muscle maintenance, energy production, and cognitive function.** Made for everyday strength."
  },
  "b-active": {
    "category": "supplement",
    "tagline": "Multi-B with 5-MTHF",
    "format": "Dietary Supplement · Liquid Formula",
    "how_to_take": "Take as directed on the label and by your THINNR provider.",
    "facts_title": "Ingredients",
    "disclaimer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.",
    "benefits": [
      "Supports cellular energy metabolism and reduces fatigue**",
      "Promotes healthy brain function and mental clarity**",
      "Supports healthy homocysteine levels and heart function**",
      "Helps support healthy neurological function**",
      "Supports balanced mood, stress resilience, and restful sleep**"
    ],
    "facts": [
      {
        "name": "5-MTHF (Methylfolate)",
        "detail": "The methylated, active form of folic acid needed for protein metabolism, RNA and DNA repair, and red blood cell formation."
      },
      {
        "name": "Vitamin B12 (Methylcobalamin)",
        "detail": "Required for red blood cell formation, DNA synthesis, and proper neurological function."
      },
      {
        "name": "Vitamin B6 (Pyridoxal 5-Phosphate)",
        "detail": "Bioactive, water-soluble vitamin utilized by the nervous and immune systems."
      },
      {
        "name": "Vitamin B6 (Pyridoxine HCl)",
        "detail": "Essential for red blood cell metabolism and hemoglobin production."
      }
    ],
    "faqs": [
      {
        "question": "Where can I get B-Active?",
        "answer": "Available through certified THINNR healthcare providers."
      },
      {
        "question": "Has the FDA evaluated these statements?",
        "answer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."
      }
    ],
    "description": "Highly absorbable, bioactive forms of essential B vitamins in a convenient liquid formula. Uses methylated forms for maximum bioavailability, making them easier for your body to absorb and utilize.**"
  },
  "boost": {
    "category": "drops",
    "tagline": "Supports Any Weight Loss, Including Prescription Programs",
    "format": "Homeopathic OTC Medication · Sublingual Drops",
    "how_to_take": "Sublingual drops. Take as directed by your THINNR provider.",
    "facts_title": "Active Ingredients (HPUS)",
    "disclaimer": "*Claims for this product are based on traditional homeopathic practice, not accepted modern medical evidence. The FDA has not evaluated these claims.",
    "benefits": [
      "Homeopathic OTC formulation using HPUS-listed ingredients*",
      "Designed to support the body during any weight management program*",
      "Can be used alongside prescription weight management programs",
      "Sublingual drops - easy administration, no injections required"
    ],
    "facts": [
      {
        "name": "Adrenocorticotrophin (ACTH)",
        "detail": null
      },
      {
        "name": "Adeps suillus",
        "detail": null
      },
      {
        "name": "Adrenalinum",
        "detail": null
      },
      {
        "name": "Calcarea carbonica",
        "detail": null
      },
      {
        "name": "Pituitarum",
        "detail": null
      },
      {
        "name": "Thyroidinum",
        "detail": null
      },
      {
        "name": "Chelidonium",
        "detail": null
      }
    ],
    "faqs": [
      {
        "question": "Do Protocol or Boost have any side effects?",
        "answer": "Homeopathic products typically have little to no side effects because they use extremely diluted amounts of natural substances, often to the point where only trace elements remain. This high level of dilution means the body isn’t exposed to significant chemical doses, reducing the likelihood of adverse reactions. Additionally, homeopathy aims to stimulate the body’s natural healing response rather than override it, making it generally gentle and well-tolerated."
      },
      {
        "question": "What are the contraindications to Thinnr Boost and Thinnr Protocol?",
        "answer": "Individuals prohibited from using Thinnr Boost and Thinnr Protocol include Women who are pregnant or breastfeeding, a person with active cancer, and should not be taken by someone who has recently (last 3-4 weeks) experienced acute gallbladder problems."
      },
      {
        "question": "Will a woman on birth control pills still see results?",
        "answer": "Birth control pills should not negatively impact Thinnr Protocol or Thinnr Boost effectiveness."
      },
      {
        "question": "Is there iodine or shellfish in Boost?",
        "answer": "There is no iodine in Thinnr Protocol or Boost, and no shellfish is used in the Thinnr Protocol or Boost formula manufacturing."
      }
    ],
    "description": "THINNR Boost has many of the benefits of Thinnr Protocol with the exception of hunger support. Thinnr Boost is meant to be used in conjunction with any other weight management program, including prescription options."
  },
  "maintenance-stack": {
    "category": "bundle",
    "tagline": "Long-Term Weight Maintenance",
    "format": "3-Part Dietary Supplement System · Regulate + Detox + Control",
    "how_to_take": "Take as directed on the label and by your THINNR provider.",
    "facts_title": "What's in the Stack",
    "disclaimer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.",
    "benefits": [
      "Helps support healthy metabolic function and blood sugar levels already within normal range*",
      "Helps support healthy digestion and feelings of fullness*",
      "Helps support liver health and digestive wellness*",
      "Helps support healthy appetite for easier maintenance*",
      "Helps support healthy energy levels*"
    ],
    "facts": [
      {
        "name": "Regulate",
        "detail": "Combines the power of Berberine, Bitter Melon, and Banaba Leaf to support sustainable weight management and metabolic health."
      },
      {
        "name": "Detox",
        "detail": "Designed to support liver health, detoxification, and weight maintenance with Solarplast, Artichoke Leaf, Dandelion Leaf, Milk Thistle, Protease, and Lipase."
      },
      {
        "name": "Control",
        "detail": "Crafted to help support appetite regulation, hormonal balance, and metabolism with African Mango, Raspberry Ketone, Green Coffee Bean, and Green Tea.**"
      }
    ],
    "faqs": [
      {
        "question": "Where can I get Maintenance Stack?",
        "answer": "Available through certified THINNR healthcare providers."
      },
      {
        "question": "Has the FDA evaluated these statements?",
        "answer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."
      }
    ],
    "description": "A comprehensive 3-part system designed to support long-term weight maintenance, metabolic health, and overall wellness after completing your weight management journey."
  },
  "maintenance-stack-2": {
    "category": "bundle",
    "tagline": "Long-Term Weight Maintenance",
    "format": "2-Part Dietary Supplement System · Two of Regulate, Detox, and Control",
    "how_to_take": "Take as directed on the label and by your THINNR provider.",
    "facts_title": "What's in the Stack",
    "disclaimer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.",
    "benefits": [
      "Helps support healthy metabolic function and blood sugar levels already within normal range*",
      "Helps support healthy digestion and feelings of fullness*",
      "Helps support liver health and digestive wellness*",
      "Helps support healthy appetite for easier maintenance*",
      "Helps support healthy energy levels*"
    ],
    "facts": [
      {
        "name": "Regulate",
        "detail": "Combines the power of Berberine, Bitter Melon, and Banaba Leaf to support sustainable weight management and metabolic health."
      },
      {
        "name": "Detox",
        "detail": "Designed to support liver health, detoxification, and weight maintenance with Solarplast, Artichoke Leaf, Dandelion Leaf, Milk Thistle, Protease, and Lipase."
      },
      {
        "name": "Control",
        "detail": "Crafted to help support appetite regulation, hormonal balance, and metabolism with African Mango, Raspberry Ketone, Green Coffee Bean, and Green Tea.**"
      }
    ],
    "faqs": [
      {
        "question": "Where can I get the Maintenance Stack?",
        "answer": "Available through certified THINNR healthcare providers."
      },
      {
        "question": "Has the FDA evaluated these statements?",
        "answer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."
      }
    ],
    "description": "A two-product version of the Maintenance Stack. Your provider chooses which two of Regulate, Detox, and Control fit your maintenance plan."
  },
  "maintenance-detox-stack": {
    "category": "bundle",
    "tagline": "Long-Term Weight Maintenance",
    "format": "Dietary Supplement System · Regulate + Detox + Control, plus Detox",
    "how_to_take": "Take as directed on the label and by your THINNR provider.",
    "facts_title": "What's in the Stack",
    "disclaimer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease.",
    "benefits": [
      "Helps support healthy metabolic function and blood sugar levels already within normal range*",
      "Helps support healthy digestion and feelings of fullness*",
      "Helps support liver health and digestive wellness*",
      "Helps support healthy appetite for easier maintenance*",
      "Helps support healthy energy levels*"
    ],
    "facts": [
      {
        "name": "Regulate",
        "detail": "Combines the power of Berberine, Bitter Melon, and Banaba Leaf to support sustainable weight management and metabolic health."
      },
      {
        "name": "Detox",
        "detail": "Designed to support liver health, detoxification, and weight maintenance with Solarplast, Artichoke Leaf, Dandelion Leaf, Milk Thistle, Protease, and Lipase."
      },
      {
        "name": "Control",
        "detail": "Crafted to help support appetite regulation, hormonal balance, and metabolism with African Mango, Raspberry Ketone, Green Coffee Bean, and Green Tea.**"
      },
      {
        "name": "Detox (additional)",
        "detail": "Thinnr Detox helps support your body's natural detoxification processes. This formula helps support liver health and digestive wellness.**"
      }
    ],
    "faqs": [
      {
        "question": "Where can I get the Maintenance Stack?",
        "answer": "Available through certified THINNR healthcare providers."
      },
      {
        "question": "Has the FDA evaluated these statements?",
        "answer": "**These statements have not been evaluated by the US FDA. This product is not intended to diagnose, treat, prevent, or cure any disease."
      }
    ],
    "description": "The full Maintenance Stack (Regulate, Detox, and Control) paired with Detox for ongoing liver and digestive support after your weight management program."
  }
};
