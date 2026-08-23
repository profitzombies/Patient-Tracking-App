# THINNR Program — Official Reference Documents

Verbatim archive of the official THINNR Protocol materials. Nothing in this directory is paraphrased, corrected, condensed, or reorganized — apparent typos and oddities in the originals are preserved as-is. When app features, patient guidance, or seed data need official wording, quote it from these files.

## Files

| File | What it is | Source |
| --- | --- | --- |
| `source/202511_Thinnr_Manual-Edit11-25-F_1787426511659.pdf` | The official 72-page THINNR Protocol manual — canonical original | Copied unchanged from `attached_assets/` |
| `source/Pasted-Thinnr-Protocol-Protocol-Knowledge-Base-How-Does-Homeop_1787426445412.txt` | The pasted Protocol Knowledge Base Q&A — canonical original | Copied unchanged from `attached_assets/` |
| `source/Pasted-PROTOCOL-GUIDE-WEIGHT-LOSS-PROGRAM-Welcome-to-Your-Tran_1787428528970.txt` | User-pasted flowed-text copy of the manual (cover through printed page 70) — secondary source; the PDF stays canonical | Copied unchanged from `attached_assets/` |
| `source/Pasted-THINNRRESTAURANT-GUIDE-EATING-OUT-THE-THINNR-WAY-A-prac_1787491903014.txt` | The pasted THINNR Restaurant Guide ("EATING OUT, THE THINNR WAY") — canonical original | Copied unchanged from `attached_assets/` |
| `manual-transcription.md` | Complete verbatim transcription of all 72 manual pages, one `--- Page N ---` block per PDF page | Extracted from the manual PDF with `pdftotext -layout` (Poppler 25.07.0) |
| `protocol-knowledge-base.txt` | Protocol Knowledge Base Q&A | Byte-for-byte copy of the pasted source |
| `program-instructions.md` | Program instructions: PDF pages 4–9 (printed pages 5–10) — introduction, Metabolic Activation Phase, Metabolic Thinning Phase, Thinning Nutrition Strategy, Vegetarian and Vegan Guidelines, Normalization Nutrition Strategy, Additional Low-Glycemic & Anti-Inflammatory Foods | Blocks copied unchanged from `manual-transcription.md` |
| `approved-foods.md` | Approved foods: PDF pages 45–47 (printed pages 46–48, Thinnr Nutrition Strategy Approved Selections) plus PDF page 9 (printed page 10, Additional Low-Glycemic & Anti-Inflammatory Foods) | Blocks copied unchanged from `manual-transcription.md` |
| `restaurant-guide.txt` | THINNR Restaurant Guide ("EATING OUT, THE THINNR WAY"): the BEFORE YOU ORDER rules and the THINNR-APPROVED RESTAURANT OPTIONS directory (Applebee’s through Zaxby’s, 25 restaurants) | Byte-for-byte copy of the pasted source |

## Page numbering

`--- Page N ---` markers use PDF page indices (1–72). The manual's printed footer numbers run one ahead of the PDF index: PDF page N shows printed page number N+1 (holds for PDF pages 2–69; pages 1 and 70–72 are cover/back matter without footers).

Manual structure by PDF page: 1 front cover · 2 welcome · 3 index · 4 introduction · 5–9 program instructions · 10 recipe-book intro · 11–44 recipes (beef, poultry, seafood, pork, vegetable) · 45–47 Nutrition Strategy Approved Selections · 48 Metabolic Activation Phase weight & food journal (Days 1–2) · 49–69 daily tracking sheets (Days 3–43) · 70 notes page · 71 blank · 72 back cover.

## Fidelity notes

- Every text page's block (the lines between its `--- Page N ---` marker and the blank separator line before the next marker) is byte-identical to fresh `pdftotext -layout` output for that page with only the trailing page-separator form feed dropped (verified programmatically for all 67 text pages). The blank separator line between blocks belongs to the file format, not to the page text.
- Pages 1, 70, 71, 72 have essentially no text layer (cover/back matter). They carry bracketed `[...]` notes describing the artwork instead of invented text; page 1's two extractable lines are preserved above its note.
- PDF page 9 (printed 10): the two "Additional Low-Glycemic & Anti-Inflammatory Foods" tables exist on the page only as graphics with no text layer. Their wording was transcribed verbatim from renders at 200–600 dpi (small glyphs such as the ½ fraction confirmed from 600-dpi crops) and appended to that page's block behind a clearly bracketed note.
- The knowledge-base document and all `source/` files are byte-identical to the originals in `attached_assets/` (sha256-verified).
- The separately pasted flowed-text copy of the manual was cross-checked against the PDF text layer page by page: word-for-word identical everywhere comparable, with the only token differences being where copy/paste split the table-of-contents dot-leader lines (those two pages are character-identical once dots/whitespace are ignored). The paste contains no trace of the page-9 tables, independently confirming they exist only as graphics.
- The restaurant guide (`restaurant-guide.txt` and its `source/` original) is byte-identical to the paste in `attached_assets/` (sha256-verified). Its typos and oddities are preserved as-is — e.g. the run-together "THINNRRESTAURANT GUIDE" page header, "Tariyaki", "Carl’s jr.", and inconsistent dash spacing in the order lines. Bullet lines hard-wrap mid-sentence (continuation lines start lowercase); the `© 2025-6 SlimCell` footer and page-header lines repeat between restaurant blocks and belong to the paste, not to any restaurant's entry.
- If anything here ever disagrees with the source PDF or paste, the original wins. Do not edit these files.

## Checksums (sha256)

- `source/202511_Thinnr_Manual-Edit11-25-F_1787426511659.pdf`: `8e98d2c5852990a45efc4f08f9c6c3773d11f4a1f2738ba01b9d26f7ebd8d434`
- `source/Pasted-Thinnr-Protocol-Protocol-Knowledge-Base-How-Does-Homeop_1787426445412.txt` and `protocol-knowledge-base.txt`: `639841dc72ff40077e931cc3a35a7e069b3abb9fb8ecf7d8d26bcd16f3658984`
- `source/Pasted-PROTOCOL-GUIDE-WEIGHT-LOSS-PROGRAM-Welcome-to-Your-Tran_1787428528970.txt`: `819844596a54bc13ec107ce7361dba101461ac6ad3b919defb48ecd221f8d838`
- `source/Pasted-THINNRRESTAURANT-GUIDE-EATING-OUT-THE-THINNR-WAY-A-prac_1787491903014.txt` and `restaurant-guide.txt`: `0239514a15e6df86993754b8203582be4d91fa8f414d178f9e9bda94fc5893ab`
