#!/usr/bin/env python3
"""Build the deterministic 5,000-row USDA SR Legacy catalog expansion.

Usage:
  python scripts/build-usda-expanded-catalog.py /path/to/extracted/csv/directory

The official source archive is:
https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip
"""

import csv
import json
import pathlib
import re
import sys

COUNT = 5_000
OUNCE_GRAMS = 28.349523125
PROTEIN_CATEGORY_IDS = {"5", "7", "10", "13", "15", "17"}
EXCLUDED_CATEGORY_IDS = {"3", "21", "25"}
NUTRIENT_FIELDS = {"1008": "calories", "1003": "protein", "1005": "carbs", "1004": "fat"}
CATEGORY_24_ANIMAL_PATTERN = re.compile(
    r"\b(?:ascidians?|bear|buffalo|caribou|chiton|cockles?|deer|duck|elk|fish|"
    r"moose|mutton|octopus|oopah|owl|salmon|sea cucumber|sea lion|seal|smelt|"
    r"squirrel|trout|walrus|whale)\b",
    re.IGNORECASE,
)


def read_csv(base: pathlib.Path, name: str):
    with (base / name).open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def title_case_usda(value: str) -> str:
    """Title-case USDA descriptions at this source's single inbound seam."""
    small = {
        "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into",
        "nor", "of", "on", "onto", "or", "over", "per", "so", "the", "to", "up",
        "via", "with",
    }
    words = value.strip().split()
    result = []
    for index, word in enumerate(words):
        if any(char.isupper() for char in word[1:]):
            result.append(word)
            continue
        bare = "".join(char for char in word.lower() if char.isalpha())
        if index not in {0, len(words) - 1} and bare in small:
            result.append(word.lower())
            continue
        segments = []
        for segment in word.lower().split("-"):
            first_letter = next((i for i, char in enumerate(segment) if char.isalpha()), None)
            if first_letter is None:
                segments.append(segment)
            else:
                segments.append(
                    segment[:first_letter]
                    + segment[first_letter].upper()
                    + segment[first_letter + 1:]
                )
        result.append("-".join(segments))
    return " ".join(result)


def rounded(value: float) -> float:
    return round(value + 1e-12, 2)


def is_program_protein(category_id: str, description: str) -> bool:
    if category_id in PROTEIN_CATEGORY_IDS:
        return True
    if category_id != "24":
        return False
    lower = description.lower()
    if re.match(r"^(agutuk|oil|soup|stew|tamales?)\b", lower):
        return False
    if "blubber" in lower or re.match(r"^whale, .*(?:fat|skin)", lower):
        return False
    return CATEGORY_24_ANIMAL_PATTERN.search(description) is not None


def portion_label(portion: dict, units: dict[str, str]) -> str:
    amount = float(portion["amount"])
    amount_text = str(int(amount)) if amount.is_integer() else f"{amount:g}"
    unit = units.get(portion["measure_unit_id"], "").strip()
    if unit.lower() == "undetermined":
        unit = ""
    detail = (portion["portion_description"] or portion["modifier"]).strip()
    label = " ".join(piece for piece in (amount_text, unit, detail) if piece)
    return re.sub(r"\s+", " ", label).strip()


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Pass the extracted USDA CSV directory")
    base = pathlib.Path(sys.argv[1])
    output = pathlib.Path(__file__).resolve().parents[1] / "src/catalog/usda-expanded.json"

    units = {row["id"]: row["name"] for row in read_csv(base, "measure_unit.csv")}
    categories = {row["id"]: row["description"] for row in read_csv(base, "food_category.csv")}
    foods = {row["fdc_id"]: row for row in read_csv(base, "food.csv")}
    nutrients: dict[str, dict[str, float]] = {}
    for row in read_csv(base, "food_nutrient.csv"):
        field = NUTRIENT_FIELDS.get(row["nutrient_id"])
        if field and row["amount"]:
            nutrients.setdefault(row["fdc_id"], {})[field] = float(row["amount"])

    portions: dict[str, list[dict]] = {}
    for row in read_csv(base, "food_portion.csv"):
        if row["gram_weight"] and float(row["gram_weight"]) > 0:
            portions.setdefault(row["fdc_id"], []).append(row)
    for rows in portions.values():
        rows.sort(key=lambda row: int(row["seq_num"]))

    # Keep the original reviewed essentials canonical when an FDC id overlaps.
    essentials_path = pathlib.Path(__file__).resolve().parents[2] / "thinnr-mobile/data/usda-essentials.ts"
    essential_ids = set(re.findall(r"(?<!\d)(\d{6})\|", essentials_path.read_text(encoding="utf-8")))

    candidates: dict[str, list[dict]] = {}
    for fdc_id in sorted(foods, key=int):
        food = foods[fdc_id]
        macro = nutrients.get(fdc_id, {})
        category_id = food["food_category_id"]
        if (
            category_id in EXCLUDED_CATEGORY_IDS
            or fdc_id in essential_ids
            or set(macro) != set(NUTRIENT_FIELDS.values())
        ):
            continue
        name = title_case_usda(food["description"])
        if not name or len(name) > 160:
            continue

        protein = is_program_protein(category_id, food["description"])
        if protein:
            serving_grams = 5 * OUNCE_GRAMS
            serving_label = "5 oz"
            portion_source_id = None
            portion_policy = "protein_5_oz"
        else:
            natural = next((row for row in portions.get(fdc_id, []) if portion_label(row, units)), None)
            if natural is None:
                continue
            serving_grams = float(natural["gram_weight"])
            serving_label = portion_label(natural, units)
            portion_source_id = natural["id"]
            portion_policy = "usda_household"

        scale = serving_grams / 100
        measures = [{"label": serving_label, "grams": rounded(serving_grams)}]
        if serving_label != "100 g":
            measures.append({"label": "100 g", "grams": 100})
        if serving_label not in {"1 oz", "5 oz"}:
            measures.append({"label": "1 oz", "grams": OUNCE_GRAMS})

        candidates.setdefault(category_id, []).append({
            "kind": "generic",
            "name": name,
            "brand": None,
            "serving_label": serving_label,
            "serving_grams": rounded(serving_grams),
            "calories": rounded(macro["calories"] * scale),
            "protein": rounded(macro["protein"] * scale),
            "carbs": rounded(macro["carbs"] * scale),
            "fat": rounded(macro["fat"] * scale),
            "measures": measures,
            "source": "usda_fdc",
            "source_id": fdc_id,
            "barcode": None,
            "quality_status": "reviewed",
            "provenance": {
                "provider": "USDA FoodData Central",
                "dataType": "SR Legacy",
                "fdcId": fdc_id,
                "release": "2018-04",
                "sourceBasis": "per 100 g",
                "sourceDescription": food["description"],
                "foodCategoryId": category_id,
                "foodCategory": categories[category_id],
                "portionPolicy": portion_policy,
                "sourcePortionId": portion_source_id,
                "coachVerdict": "unknown",
            },
        })

    # Round-robin source categories so the 5,000-row cap covers produce,
    # proteins, grains, and pantry staples rather than overrepresenting the
    # FDC ids that happen to sort first.
    rows = []
    category_ids = sorted(candidates, key=int)
    offset = 0
    while len(rows) < COUNT:
        added = False
        for category_id in category_ids:
            category_rows = candidates[category_id]
            if offset < len(category_rows):
                rows.append(category_rows[offset])
                added = True
                if len(rows) == COUNT:
                    break
        if not added:
            break
        offset += 1

    if len(rows) != COUNT:
        raise SystemExit(f"Expected {COUNT} complete rows, found {len(rows)}")
    output.write_text(json.dumps(rows, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(rows)} rows to {output}")


if __name__ == "__main__":
    main()