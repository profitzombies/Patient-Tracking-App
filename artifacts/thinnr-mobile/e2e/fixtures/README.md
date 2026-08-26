# e2e fixtures

Real image files for Playwright-driven e2e runs (the web photo pickers hand
these to `expo-image-manipulator`, whose web decoder rejects synthetic
in-page buffers — always point the file chooser at a real repo file).

## nutrition-label-cereal.jpg

A clean FDA-style Nutrition Facts panel for the coach-chat label-to-food
flow. Rendered deterministically (ImageMagick + Inter), so the vision
transcription should read back exactly what is printed:

| Field                  | Printed value  |
| ---------------------- | -------------- |
| Serving size           | 2/3 cup (55g)  |
| Servings per container | 8              |
| Calories               | 230            |
| Total fat              | 8g             |
| Total carbohydrate     | 37g            |
| Protein                | 3g             |
| Dietary fiber          | 4g             |
| Total sugars           | 12g            |
| Sodium                 | 160mg          |

Printed calories agree with the 4/4/9 macro math (3·4 + 37·4 + 8·9 = 232 ≈ 230),
so the read must NOT set the `flagged` misprint warning. Expected food card
lines: serving `2/3 cup (55g) · 8 per container`, macros `230 CAL · 3P · 37C · 8F`,
extras `4g fiber · 12g sugar · 160mg sodium`.

Regenerate with `magick` if values ever need to change (keep the 4/4/9 math
consistent unless deliberately testing the misprint flag).
