/**
 * Conservative food-name tagging.
 *
 * The classifier reads closed-vocabulary tags; catalog foods carry them, but
 * the coach meets foods as free text (a recipe ingredient, a menu dish, a
 * food the patient typed). This module infers tags from such text so a
 * recorded restriction, sensitivity or diet rule can still fire.
 *
 * Deliberately conservative: a missed tag leaves the verdict at "unknown"
 * (honest), while a wrong tag would wrongly tell a patient a food does not
 * fit. So only unambiguous food words tag, compound names that would mislead
 * ("almond milk", "turkey bacon", "cauliflower rice") are rewritten first,
 * and explicit qualifiers ("gluten free", "vegan", "decaf") strip the tags
 * they rule out.
 */
import type { FoodTag } from "./vocabulary";

const normalize = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Compound names rewritten BEFORE word tagging so a misleading word never
 * fires: the replacement keeps the words that do describe the food.
 */
const REWRITES: ReadonlyArray<readonly [string, string]> = [
  ["almond milk", "almond"], ["oat milk", "oats"], ["soy milk", "soy"], ["coconut milk", "coconut"], ["cashew milk", "cashew"],
  ["rice milk", "rice"], ["coconut cream", "coconut"], ["coconut yogurt", "coconut"], ["cashew cheese", "cashew"], ["vegan cheese", "plant"],
  ["peanut butter", "peanut"], ["almond butter", "almond"], ["cashew butter", "cashew"], ["sunflower butter", "seed"], ["nut butter", "tree nut"],
  ["cocoa butter", "cocoa"], ["apple butter", "apple"], ["butternut", "squash"], ["buttermilk", "milk"],
  ["turkey bacon", "turkey processed"], ["chicken sausage", "chicken processed"], ["turkey sausage", "turkey processed"],
  ["veggie burger", "vegetable"], ["bean burger", "beans"], ["black bean burger", "beans"], ["plant based burger", "plant"],
  ["beyond burger", "plant"], ["impossible burger", "plant"], ["veggie sausage", "vegetable"], ["vegan sausage", "plant"],
  ["cauliflower rice", "cauliflower"], ["rice noodles", "rice"], ["rice pasta", "rice"], ["chickpea pasta", "chickpeas"], ["lentil pasta", "lentils"],
  ["zucchini noodles", "zucchini"], ["oyster mushroom", "mushroom"], ["oyster mushrooms", "mushroom"], ["eggplant", "nightshade"],
  ["water chestnut", "vegetable"], ["water chestnuts", "vegetable"], ["egg free", ""], ["sweet potato", "sweetpotato"], ["sweet potatoes", "sweetpotato"],
  ["cream of tartar", ""], ["corn tortilla", "corn"], ["corn tortillas", "corn"], ["flour tortilla", "wheat"], ["flour tortillas", "wheat"],
  ["coffee cake", "cake"], ["chicken of the sea", "tuna"], ["ice cream", "dairy"], ["sour cream", "dairy"], ["cream cheese", "dairy"],
  ["fish sauce", "fish"], ["soy sauce", "soy wheat"], ["hot sauce", "spicy"], ["energy drink", "caffeine"], ["green tea", "tea"],
  ["black tea", "tea"], ["herbal tea", ""], ["root beer", "soda"], ["ginger beer", "soda"], ["ginger ale", "soda"], ["club soda", "carbonated"],
  ["sparkling water", "carbonated"], ["seltzer", "carbonated"],
  ["sushi roll", "sushi"], ["sushi rolls", "sushi"], ["spring roll", "rice"], ["spring rolls", "rice"], ["summer roll", "rice"], ["summer rolls", "rice"],
  ["egg roll", "egg wheat fried"], ["egg rolls", "egg wheat fried"], ["lettuce wrap", "lettuce"], ["lettuce wraps", "lettuce"], ["collard wrap", "greens"], ["cabbage roll", "cabbage"], ["cabbage rolls", "cabbage"],
  ["goat cheese", "cheese"], ["goat milk", "milk"], ["goat yogurt", "yogurt"], ["kidney beans", "beans"], ["kidney bean", "beans"], ["cauliflower wings", "cauliflower fried"],
  ["vanilla bean", "vanilla"], ["coffee beans", "coffee"], ["coffee bean", "coffee"], ["cocoa beans", "cocoa"], ["black pepper", "seasoning"], ["white pepper", "seasoning"], ["peppercorn", "seasoning"], ["peppercorns", "seasoning"],
  ["cream soda", "soda"], ["cashew cream", "cashew"], ["cream of wheat", "wheat"], ["butter lettuce", "lettuce"], ["butter beans", "beans"], ["lemon juice", "lemon"], ["lime juice", "lime"],
  ["sugar snap", "peas"], ["smoked paprika", "paprika"], ["smoked turkey", "turkey processed"], ["smoked sausage", "sausage"], ["apple cider vinegar", "vinegar"], ["cider vinegar", "vinegar"],
  ["rice vinegar", "vinegar"], ["red wine vinegar", "vinegar"], ["white wine vinegar", "vinegar"], ["balsamic vinegar", "vinegar"], ["hard cider", "alcohol"],
  ["chocolate chips", "chocolate"], ["tortilla chips", "corn chips"], ["kale chips", "kale"], ["banana chips", "banana fried"], ["apple chips", "apple"], ["rice cake", "rice"], ["rice cakes", "rice"],
  ["shepherd s pie", "beef potato"], ["chamomile tea", ""], ["peppermint tea", "mint"], ["ginger tea", ""], ["rooibos tea", ""], ["rooibos", ""],
];

/** Explicit qualifiers that rule tags OUT after matching. */
const QUALIFIERS: ReadonlyArray<readonly [string, readonly FoodTag[]]> = [
  ["gluten free", ["gluten", "wheat"]],
  ["dairy free", ["dairy", "milk", "aged_cheese", "high_fat_dairy", "butter", "lactose"]],
  ["lactose free", ["lactose"]],
  ["sugar free", ["added_sugar", "sweetened_beverage"]],
  ["unsweetened", ["added_sugar", "sweetened_beverage"]],
  ["decaf", ["caffeine", "coffee"]],
  ["decaffeinated", ["caffeine", "coffee"]],
  ["non alcoholic", ["alcohol", "beer"]],
  ["alcohol free", ["alcohol", "beer"]],
  ["vegan", ["meat", "red_meat", "pork", "poultry", "processed_meat", "organ_meat", "fish", "oily_fish", "shellfish", "high_mercury_fish", "raw_fish", "egg", "raw_egg", "dairy", "milk", "aged_cheese", "high_fat_dairy", "butter", "honey", "lactose"]],
  ["plant based", ["meat", "red_meat", "pork", "poultry", "processed_meat", "organ_meat", "fish", "oily_fish", "shellfish", "high_mercury_fish", "raw_fish", "egg", "raw_egg", "dairy", "milk", "aged_cheese", "high_fat_dairy", "butter", "lactose"]],
  ["vegetarian", ["meat", "red_meat", "pork", "poultry", "processed_meat", "organ_meat", "fish", "oily_fish", "shellfish", "high_mercury_fish", "raw_fish"]],
  ["low sodium", ["high_sodium"]],
  ["non dairy", ["dairy", "milk", "aged_cheese", "high_fat_dairy", "butter", "lactose"]],
  ["mild", ["spicy"]],
];

const PORK: FoodTag[] = ["meat", "red_meat", "pork"];
const CURED_PORK: FoodTag[] = ["meat", "red_meat", "pork", "processed_meat", "high_sodium", "high_histamine"];
const RED: FoodTag[] = ["meat", "red_meat"];
const POULTRY: FoodTag[] = ["meat", "poultry"];
const FISH: FoodTag[] = ["fish"];
const OILY: FoodTag[] = ["fish", "oily_fish", "high_histamine"];
const SHELL: FoodTag[] = ["shellfish", "high_purine"];
const DAIRY: FoodTag[] = ["dairy", "milk", "lactose"];
const AGED: FoodTag[] = ["dairy", "aged_cheese", "high_fat_dairy", "high_histamine"];
const WHEAT: FoodTag[] = ["grain", "refined_grain", "gluten", "wheat", "high_fodmap"];
const SWEET: FoodTag[] = ["added_sugar", "ultra_processed"];
const NUT: FoodTag[] = ["tree_nut"];

/**
 * Word (or phrase) → tags. Whole-word matches on the rewritten text. Plurals
 * are listed where they are common; unusual forms simply do not match.
 */
const WORD_TAGS: ReadonlyArray<readonly [string, readonly FoodTag[]]> = [
  // pork
  ["pork", PORK], ["bacon", CURED_PORK], ["ham", CURED_PORK], ["prosciutto", CURED_PORK], ["pancetta", CURED_PORK], ["pepperoni", CURED_PORK],
  ["salami", CURED_PORK], ["chorizo", CURED_PORK], ["lard", ["pork", "high_fat"]], ["ribs", RED], ["pork chop", PORK], ["pork chops", PORK],
  ["processed", ["processed_meat", "high_sodium"]], ["sausage", ["meat", "processed_meat", "high_sodium"]], ["sausages", ["meat", "processed_meat", "high_sodium"]], ["hot dog", ["meat", "processed_meat", "high_sodium", "ultra_processed"]],
  ["hot dogs", ["meat", "processed_meat", "high_sodium", "ultra_processed"]], ["deli meat", ["meat", "processed_meat", "high_sodium"]], ["cold cuts", ["meat", "processed_meat", "high_sodium"]],
  ["jerky", ["meat", "processed_meat", "high_sodium"]], ["pastrami", ["meat", "red_meat", "processed_meat", "high_sodium"]], ["corned beef", ["meat", "red_meat", "processed_meat", "high_sodium"]],
  // red meat
  ["beef", RED], ["steak", RED], ["burger", RED], ["burgers", RED], ["hamburger", RED], ["cheeseburger", [...RED, "dairy", "high_fat_dairy"]], ["meatball", ["meat", "red_meat"]], ["meatballs", ["meat", "red_meat"]],
  ["meatloaf", ["meat", "red_meat"]], ["lamb", RED], ["veal", RED], ["bison", RED], ["venison", RED], ["goat", RED], ["brisket", RED], ["sirloin", RED], ["ribeye", RED], ["filet mignon", RED],
  ["liver", ["meat", "organ_meat", "high_purine"]], ["kidney", ["meat", "organ_meat", "high_purine"]], ["sweetbreads", ["meat", "organ_meat", "high_purine"]], ["pate", ["meat", "organ_meat", "high_purine"]],
  // poultry
  ["chicken", POULTRY], ["turkey", POULTRY], ["duck", POULTRY], ["goose", POULTRY], ["quail", POULTRY], ["cornish hen", POULTRY], ["rotisserie", POULTRY], ["wings", POULTRY], ["drumstick", POULTRY], ["drumsticks", POULTRY],
  // fish
  ["fish", FISH], ["cod", FISH], ["tilapia", FISH], ["halibut", FISH], ["haddock", FISH], ["flounder", FISH], ["sole", FISH], ["bass", FISH], ["snapper", FISH], ["grouper", FISH], ["catfish", FISH], ["pollock", FISH], ["mahi", FISH],
  ["salmon", OILY], ["tuna", [...OILY, "high_mercury_fish"]], ["mackerel", [...OILY, "high_mercury_fish", "high_purine"]], ["sardine", [...OILY, "high_purine"]], ["sardines", [...OILY, "high_purine"]],
  ["anchovy", [...OILY, "high_purine", "high_sodium"]], ["anchovies", [...OILY, "high_purine", "high_sodium"]], ["herring", [...OILY, "high_purine"]], ["trout", OILY], ["swordfish", [...FISH, "high_mercury_fish"]],
  ["sushi", ["fish", "raw_fish", "rice", "grain"]], ["sashimi", ["fish", "raw_fish"]], ["ceviche", ["fish", "raw_fish", "citrus"]], ["smoked salmon", [...OILY, "high_sodium", "processed_meat"]], ["lox", [...OILY, "high_sodium"]],
  // shellfish
  ["shrimp", SHELL], ["prawn", SHELL], ["prawns", SHELL], ["crab", SHELL], ["lobster", SHELL], ["clam", SHELL], ["clams", SHELL], ["mussel", SHELL], ["mussels", SHELL], ["oyster", SHELL], ["oysters", SHELL],
  ["scallop", SHELL], ["scallops", SHELL], ["crawfish", SHELL], ["crayfish", SHELL], ["calamari", SHELL], ["squid", SHELL], ["octopus", SHELL], ["shellfish", SHELL],
  // eggs
  ["egg", ["egg"]], ["eggs", ["egg"]], ["omelet", ["egg"]], ["omelette", ["egg"]], ["frittata", ["egg"]], ["quiche", ["egg", "dairy", "gluten", "wheat", "grain", "refined_grain"]], ["mayonnaise", ["egg", "seed_oil", "high_fat"]], ["mayo", ["egg", "seed_oil", "high_fat"]],
  ["hollandaise", ["egg", "butter", "dairy", "high_fat"]], ["aioli", ["egg", "high_fat"]],
  // dairy
  ["milk", DAIRY], ["dairy", ["dairy"]], ["cheese", ["dairy", "high_fat_dairy"]], ["cheesecake", ["dairy", "high_fat_dairy", "added_sugar", "grain", "refined_grain", "gluten", "wheat"]], ["yogurt", ["dairy", "lactose", "fermented"]], ["yoghurt", ["dairy", "lactose", "fermented"]], ["kefir", ["dairy", "fermented"]],
  ["butter", ["dairy", "butter", "high_fat"]], ["ghee", ["dairy", "butter", "high_fat"]], ["cream", ["dairy", "high_fat_dairy", "lactose"]], ["whey", ["dairy", "milk"]], ["casein", ["dairy", "milk"]], ["custard", ["dairy", "egg", "added_sugar"]],
  ["parmesan", AGED], ["cheddar", AGED], ["gouda", AGED], ["gruyere", AGED], ["brie", AGED], ["camembert", AGED], ["blue cheese", AGED], ["gorgonzola", AGED], ["feta", ["dairy", "aged_cheese", "high_sodium"]],
  ["alfredo", ["dairy", "high_fat_dairy", "high_fat"]], ["mozzarella", ["dairy", "high_fat_dairy"]], ["ricotta", ["dairy", "lactose"]], ["cottage cheese", ["dairy", "lactose"]], ["paneer", ["dairy"]], ["halloumi", ["dairy", "high_sodium"]], ["queso", ["dairy", "high_fat_dairy"]],
  ["latte", ["dairy", "milk", "coffee", "caffeine"]], ["cappuccino", ["dairy", "milk", "coffee", "caffeine"]], ["milkshake", ["dairy", "milk", "added_sugar", "sweetened_beverage"]],
  // grains
  ["wheat", WHEAT], ["bread", WHEAT], ["toast", WHEAT], ["bagel", WHEAT], ["bagels", WHEAT], ["bun", WHEAT], ["buns", WHEAT], ["roll", WHEAT], ["rolls", WHEAT], ["croissant", [...WHEAT, "butter", "dairy", "high_fat"]],
  ["pasta", WHEAT], ["spaghetti", WHEAT], ["penne", WHEAT], ["fettuccine", WHEAT], ["linguine", WHEAT], ["macaroni", WHEAT], ["lasagna", [...WHEAT, "dairy", "aged_cheese"]], ["ravioli", [...WHEAT, "egg"]], ["gnocchi", [...WHEAT, "starchy_vegetable"]],
  ["noodle", ["grain"]], ["noodles", ["grain"]], ["ramen", [...WHEAT, "high_sodium", "ultra_processed"]], ["udon", WHEAT], ["couscous", WHEAT], ["bulgur", ["grain", "whole_grain", "gluten", "wheat", "high_fodmap"]], ["farro", ["grain", "whole_grain", "gluten", "wheat"]],
  ["semolina", WHEAT], ["seitan", ["gluten", "wheat"]], ["flour", WHEAT], ["breaded", WHEAT], ["breadcrumbs", WHEAT], ["crouton", WHEAT], ["croutons", WHEAT], ["cracker", WHEAT], ["crackers", WHEAT], ["pretzel", [...WHEAT, "high_sodium"]], ["pretzels", [...WHEAT, "high_sodium"]],
  ["pizza", [...WHEAT, "dairy", "aged_cheese", "tomato", "nightshade"]], ["sandwich", WHEAT], ["wrap", WHEAT], ["pita", WHEAT], ["naan", WHEAT], ["tortilla", WHEAT], ["tortillas", WHEAT], ["pancake", [...WHEAT, "egg", "dairy"]], ["pancakes", [...WHEAT, "egg", "dairy"]],
  ["waffle", [...WHEAT, "egg", "dairy"]], ["waffles", [...WHEAT, "egg", "dairy"]], ["muffin", [...WHEAT, "added_sugar"]], ["muffins", [...WHEAT, "added_sugar"]], ["biscuit", [...WHEAT, "butter", "dairy"]], ["biscuits", [...WHEAT, "butter", "dairy"]],
  ["barley", ["grain", "whole_grain", "gluten", "high_fodmap"]], ["rye", ["grain", "whole_grain", "gluten", "high_fodmap"]], ["oats", ["grain", "whole_grain"]], ["oatmeal", ["grain", "whole_grain"]], ["granola", ["grain", "whole_grain", "added_sugar"]],
  ["rice", ["grain", "rice"]], ["brown rice", ["grain", "whole_grain", "rice"]], ["quinoa", ["grain", "whole_grain"]], ["corn", ["grain", "corn", "starchy_vegetable"]], ["cornbread", ["grain", "corn", "wheat", "gluten", "added_sugar"]], ["polenta", ["grain", "corn"]],
  ["popcorn", ["grain", "whole_grain", "corn"]], ["cereal", ["grain", "refined_grain", "added_sugar", "ultra_processed"]], ["grits", ["grain", "corn", "refined_grain"]], ["millet", ["grain", "whole_grain"]], ["buckwheat", ["grain", "whole_grain"]],
  // legumes, soy, nuts, seeds
  ["beans", ["legume", "high_fodmap"]], ["bean", ["legume", "high_fodmap"]], ["lentil", ["legume", "high_fodmap"]], ["lentils", ["legume", "high_fodmap"]], ["chickpea", ["legume", "high_fodmap"]], ["chickpeas", ["legume", "high_fodmap"]],
  ["hummus", ["legume", "sesame", "high_fodmap"]], ["falafel", ["legume", "fried", "high_fodmap"]], ["peas", ["legume", "vegetable"]], ["edamame", ["legume", "soy"]], ["tofu", ["soy", "legume"]], ["tempeh", ["soy", "legume", "fermented"]], ["miso", ["soy", "fermented", "high_sodium"]],
  ["soy", ["soy", "legume"]], ["soybean", ["soy", "legume"]], ["natto", ["soy", "fermented"]], ["peanut", ["peanut", "legume"]], ["peanuts", ["peanut", "legume"]],
  ["almond", [...NUT, "high_oxalate"]], ["almonds", [...NUT, "high_oxalate"]], ["walnut", NUT], ["walnuts", NUT], ["cashew", [...NUT, "high_fodmap"]], ["cashews", [...NUT, "high_fodmap"]], ["pecan", NUT], ["pecans", NUT], ["pistachio", [...NUT, "high_fodmap"]], ["pistachios", [...NUT, "high_fodmap"]],
  ["hazelnut", NUT], ["hazelnuts", NUT], ["macadamia", NUT], ["brazil nut", NUT], ["brazil nuts", NUT], ["pine nut", NUT], ["pine nuts", NUT], ["tree nut", NUT], ["nuts", NUT], ["marzipan", [...NUT, "added_sugar"]], ["pesto", [...NUT, "dairy", "aged_cheese", "olive_oil"]],
  ["sesame", ["seed", "sesame"]], ["tahini", ["seed", "sesame"]], ["chia", ["seed"]], ["flax", ["seed"]], ["flaxseed", ["seed"]], ["sunflower", ["seed"]], ["pumpkin seeds", ["seed"]], ["seed", ["seed"]], ["seeds", ["seed"]],
  // vegetables
  ["broccoli", ["vegetable"]], ["cauliflower", ["vegetable", "high_fodmap"]], ["spinach", ["vegetable", "high_oxalate"]], ["kale", ["vegetable"]], ["lettuce", ["vegetable"]], ["salad", ["vegetable"]], ["greens", ["vegetable"]], ["arugula", ["vegetable"]],
  ["cucumber", ["vegetable"]], ["zucchini", ["vegetable"]], ["squash", ["vegetable"]], ["asparagus", ["vegetable", "high_fodmap"]], ["carrot", ["vegetable"]], ["carrots", ["vegetable"]], ["celery", ["vegetable"]], ["cabbage", ["vegetable"]],
  ["brussels sprouts", ["vegetable", "high_fodmap"]], ["green beans", ["vegetable"]], ["onion", ["vegetable", "high_fodmap"]], ["onions", ["vegetable", "high_fodmap"]], ["garlic", ["vegetable", "high_fodmap"]], ["leek", ["vegetable", "high_fodmap"]], ["leeks", ["vegetable", "high_fodmap"]],
  ["mushroom", ["vegetable", "high_fodmap"]], ["mushrooms", ["vegetable", "high_fodmap"]], ["avocado", ["fruit", "high_fat", "high_fodmap"]], ["beet", ["vegetable", "high_oxalate"]], ["beets", ["vegetable", "high_oxalate"]], ["rhubarb", ["vegetable", "high_oxalate"]],
  ["okra", ["vegetable", "high_oxalate"]], ["artichoke", ["vegetable", "high_fodmap"]], ["bok choy", ["vegetable"]], ["sauerkraut", ["vegetable", "fermented", "high_histamine", "high_sodium"]], ["kimchi", ["vegetable", "fermented", "high_histamine", "spicy", "high_sodium"]], ["pickles", ["vegetable", "fermented", "high_sodium"]],
  ["tomato", ["vegetable", "tomato", "nightshade", "acidic", "high_histamine"]], ["tomatoes", ["vegetable", "tomato", "nightshade", "acidic", "high_histamine"]], ["marinara", ["tomato", "nightshade", "acidic"]], ["salsa", ["tomato", "nightshade", "acidic", "spicy"]], ["ketchup", ["tomato", "nightshade", "added_sugar", "ultra_processed"]],
  ["potato", ["vegetable", "starchy_vegetable", "nightshade"]], ["potatoes", ["vegetable", "starchy_vegetable", "nightshade"]], ["fries", ["starchy_vegetable", "nightshade", "fried", "seed_oil", "high_sodium"]], ["french fries", ["starchy_vegetable", "nightshade", "fried", "seed_oil", "high_sodium"]],
  ["sweetpotato", ["vegetable", "starchy_vegetable", "high_oxalate"]], ["pepper", ["vegetable", "nightshade"]], ["peppers", ["vegetable", "nightshade"]], ["bell pepper", ["vegetable", "nightshade"]], ["jalapeno", ["vegetable", "nightshade", "spicy"]], ["jalapenos", ["vegetable", "nightshade", "spicy"]],
  ["chili", ["nightshade", "spicy"]], ["chile", ["nightshade", "spicy"]], ["paprika", ["nightshade"]], ["cayenne", ["nightshade", "spicy"]], ["sriracha", ["nightshade", "spicy", "added_sugar"]], ["curry", ["spicy"]], ["spicy", ["spicy"]], ["buffalo sauce", ["spicy", "butter", "dairy", "high_sodium"]],
  ["yam", ["starchy_vegetable"]], ["plantain", ["starchy_vegetable", "fruit"]], ["cassava", ["starchy_vegetable"]],
  // fruit
  ["fruit", ["fruit"]], ["apple", ["fruit", "high_fodmap"]], ["apples", ["fruit", "high_fodmap"]], ["pear", ["fruit", "high_fodmap"]], ["pears", ["fruit", "high_fodmap"]], ["banana", ["fruit", "high_sugar_fruit"]], ["bananas", ["fruit", "high_sugar_fruit"]],
  ["mango", ["fruit", "high_sugar_fruit", "high_fodmap"]], ["grapes", ["fruit", "high_sugar_fruit"]], ["pineapple", ["fruit", "high_sugar_fruit", "acidic"]], ["watermelon", ["fruit", "high_sugar_fruit", "high_fodmap"]], ["cherries", ["fruit", "high_sugar_fruit", "high_fodmap"]],
  ["dates", ["fruit", "high_sugar_fruit"]], ["raisins", ["fruit", "high_sugar_fruit"]], ["dried fruit", ["fruit", "high_sugar_fruit"]], ["fig", ["fruit", "high_sugar_fruit", "high_oxalate"]], ["figs", ["fruit", "high_sugar_fruit", "high_oxalate"]],
  ["berries", ["fruit", "berries"]], ["strawberry", ["fruit", "berries", "high_histamine"]], ["strawberries", ["fruit", "berries", "high_histamine"]], ["blueberry", ["fruit", "berries"]], ["blueberries", ["fruit", "berries"]], ["raspberry", ["fruit", "berries", "high_oxalate"]], ["raspberries", ["fruit", "berries", "high_oxalate"]],
  ["blackberries", ["fruit", "berries"]], ["cranberries", ["fruit", "berries"]], ["orange", ["fruit", "citrus", "acidic"]], ["oranges", ["fruit", "citrus", "acidic"]], ["lemon", ["citrus", "acidic"]], ["lime", ["citrus", "acidic"]], ["grapefruit", ["fruit", "citrus", "acidic"]], ["clementine", ["fruit", "citrus", "acidic"]],
  ["peach", ["fruit", "high_fodmap"]], ["peaches", ["fruit", "high_fodmap"]], ["plum", ["fruit", "high_fodmap"]], ["plums", ["fruit", "high_fodmap"]], ["melon", ["fruit"]], ["cantaloupe", ["fruit"]], ["kiwi", ["fruit", "acidic"]], ["papaya", ["fruit", "high_histamine"]],
  ["coconut", ["high_fat"]], ["olives", ["high_sodium", "high_fat"]],
  // fats
  ["olive oil", ["olive_oil"]], ["canola oil", ["seed_oil"]], ["vegetable oil", ["seed_oil"]], ["sunflower oil", ["seed_oil"]], ["soybean oil", ["seed_oil", "soy"]], ["margarine", ["seed_oil", "trans_fat", "ultra_processed"]], ["shortening", ["trans_fat", "high_fat"]],
  ["fried", ["fried", "high_fat"]], ["deep fried", ["fried", "high_fat", "seed_oil"]], ["tempura", ["fried", "wheat", "gluten", "grain"]], ["nuggets", ["fried", "poultry", "meat", "wheat", "gluten", "ultra_processed"]],
  // sweets, drinks
  ["sugar", ["added_sugar"]], ["syrup", ["added_sugar"]], ["honey", ["honey", "high_fodmap"]], ["agave", ["added_sugar", "high_fodmap"]], ["candy", [...SWEET]], ["chocolate", ["chocolate", "added_sugar", "caffeine"]], ["cocoa", ["chocolate", "caffeine"]], ["brownie", ["chocolate", ...SWEET, ...WHEAT, "egg", "butter", "dairy"]],
  ["cookie", [...SWEET, ...WHEAT, "butter", "dairy"]], ["cookies", [...SWEET, ...WHEAT, "butter", "dairy"]], ["cake", [...SWEET, ...WHEAT, "egg", "dairy"]], ["cupcake", [...SWEET, ...WHEAT, "egg", "dairy"]], ["pie", [...SWEET, ...WHEAT, "butter", "dairy"]], ["donut", [...SWEET, ...WHEAT, "fried"]], ["doughnut", [...SWEET, ...WHEAT, "fried"]],
  ["pastry", [...SWEET, ...WHEAT, "butter", "dairy"]], ["pastries", [...SWEET, ...WHEAT, "butter", "dairy"]], ["jam", ["added_sugar", "fruit"]], ["jelly", ["added_sugar"]], ["pudding", ["added_sugar", "dairy"]], ["sherbet", ["added_sugar", "dairy"]], ["sorbet", ["added_sugar", "fruit"]], ["frosting", SWEET], ["dessert", ["added_sugar"]],
  ["soda", ["sweetened_beverage", "carbonated", "added_sugar", "ultra_processed"]], ["cola", ["sweetened_beverage", "carbonated", "added_sugar", "caffeine", "ultra_processed"]], ["diet soda", ["sweetener", "carbonated", "ultra_processed"]], ["juice", ["sweetened_beverage", "fruit"]], ["lemonade", ["sweetened_beverage", "added_sugar", "citrus", "acidic"]],
  ["sweet tea", ["sweetened_beverage", "added_sugar", "caffeine"]], ["sports drink", ["sweetened_beverage", "added_sugar", "ultra_processed"]], ["sweetener", ["sweetener"]], ["aspartame", ["sweetener"]], ["sucralose", ["sweetener"]], ["stevia", ["sweetener"]], ["mint", ["mint"]], ["peppermint", ["mint"]],
  ["coffee", ["coffee", "caffeine", "acidic"]], ["espresso", ["coffee", "caffeine", "acidic"]], ["caffeine", ["caffeine"]], ["tea", ["caffeine"]], ["matcha", ["caffeine"]], ["kombucha", ["fermented", "caffeine", "carbonated", "high_histamine"]],
  ["wine", ["alcohol", "high_histamine", "fermented"]], ["beer", ["alcohol", "beer", "gluten", "fermented", "high_purine"]], ["vodka", ["alcohol"]], ["whiskey", ["alcohol"]], ["whisky", ["alcohol"]], ["bourbon", ["alcohol"]], ["tequila", ["alcohol"]], ["rum", ["alcohol"]], ["gin", ["alcohol"]], ["cocktail", ["alcohol", "added_sugar"]], ["margarita", ["alcohol", "added_sugar", "citrus"]],
  ["champagne", ["alcohol", "carbonated", "fermented"]], ["prosecco", ["alcohol", "carbonated", "fermented"]], ["sake", ["alcohol", "fermented"]], ["alcohol", ["alcohol"]], ["liqueur", ["alcohol", "added_sugar"]],
  // processing, leftovers
  ["canned soup", ["high_sodium", "ultra_processed"]], ["chips", ["ultra_processed", "fried", "high_sodium", "seed_oil"]], ["leftover", ["leftover"]], ["leftovers", ["leftover"]], ["vinegar", ["acidic", "fermented"]], ["pickled", ["fermented", "high_sodium", "acidic"]], ["flatbread", WHEAT],
];

interface Compiled { pattern: RegExp; tags: readonly FoodTag[] }
const COMPILED: readonly Compiled[] = WORD_TAGS.map(([phrase, tags]) => ({
  pattern: new RegExp(`(?:^| )${phrase}(?: |$)`),
  tags,
}));
const QUALIFIERS_COMPILED: ReadonlyArray<{ pattern: RegExp; tags: readonly FoodTag[] }> = QUALIFIERS.map(([phrase, tags]) => ({
  pattern: new RegExp(`(?:^| )${phrase}(?: |$)`),
  tags,
}));

/** Lower-cased text with the misleading compounds rewritten. */
export function prepareFoodText(text: string): string {
  let out = ` ${normalize(text)} `;
  for (const [compound, replacement] of REWRITES) {
    out = out.split(` ${compound} `).join(` ${replacement} `);
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * A dish is a list of components ("cheddar cheese with dairy-free bread" is
 * two). Punctuation and the joining words below separate them. Split on the
 * raw text because normalisation erases the punctuation.
 */
const COMPONENT_BREAK = /[,;:()[\]\/&+]|\bwith\b|\band\b|\bor\b|\bon\b|\bover\b|\bin\b|\bplus\b|\btopped\b|\bserved\b|\bside of\b|\balongside\b/i;

/** Each component of a food line, prepared for word matching. */
export function foodComponents(text: string): string[] {
  return text.split(COMPONENT_BREAK).map(prepareFoodText).filter(Boolean);
}

function tagsForComponent(component: string): FoodTag[] {
  const tags = new Set<FoodTag>();
  for (const entry of COMPILED) {
    if (entry.pattern.test(component)) for (const tag of entry.tags) tags.add(tag);
  }
  // A free-from qualifier only vouches for the component it sits in: the
  // "dairy-free" in "cheddar cheese with dairy-free bread" says nothing
  // about the cheese, so the cheese keeps its dairy tags.
  for (const qualifier of QUALIFIERS_COMPILED) {
    if (qualifier.pattern.test(component)) for (const tag of qualifier.tags) tags.delete(tag);
  }
  return [...tags];
}

/**
 * Tags a free-text food name (optionally with ingredient names). Returns an
 * empty array when nothing unambiguous matched, which the classifier reads
 * as "unknown food" rather than "fits". Tags are the UNION over components;
 * a qualifier never removes a tag another component earned, so a dish is
 * only ever as free-from as its least free-from part.
 */
export function inferFoodTags(name: string, ingredients: readonly string[] = []): FoodTag[] {
  const tags = new Set<FoodTag>();
  for (const line of [name, ...ingredients]) {
    for (const component of foodComponents(line)) {
      for (const tag of tagsForComponent(component)) tags.add(tag);
    }
  }
  return [...tags];
}
