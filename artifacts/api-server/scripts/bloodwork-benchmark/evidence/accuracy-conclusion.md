# Synthetic extraction qualification conclusion

Evidence file: `accuracy-qualified-2026-09-11.json`

The overflow fixture was corrected before qualification. It now contains 201
short rows in three columns (`x=20,220,420`), with y coordinates 760 through
166 on one 612x792 PDF page. The coordinate sanity test passed and the
rendered preview showed all three columns and all 201 labels on-page. The
earlier one-column fixture was not used as an accuracy result because most
rows were below the page.

## Result

* `gpt-5.6-terra`: **pass** — clear digital, clear embedded-raster scanned,
  poor embedded-raster scanned, and visible-201-row overflow all passed.
* `gpt-5.6-luna`: **pass** — the same four cases passed.
* `gpt-5.4-mini`: **inconclusive/not qualified** — all three ordinary pages
  passed, but the corrected overflow request received no model response after
  the bounded attempts (`AI_FAILED`, zero response events). This is reported
  as `not-run`, not as a fabricated overflow accuracy failure.

The two passing models had zero exact-field errors, row-order errors, missed
rows, or extra/duplicate rows on ordinary pages. Decimal precision,
comparators, units, reference ranges, printed flags, and qualitative values
all matched. Terra and Luna both returned the fail-closed
`TOO_MANY_RESULTS` code for the visible 201-row page.

Representative measured transcription times from the sanitized evidence:

| Model | Clear digital | Clear scanned | Poor scanned | Overflow |
| --- | ---: | ---: | ---: | ---: |
| terra | 2893.706 ms | 3781.319 ms | 3477.118 ms | 2106.973 ms |
| luna | 3515.244 ms | 3207.998 ms | 3574.216 ms | 2033.159 ms |
| mini | 1814.912 ms | 1698.406 ms | 1851.889 ms | no response |

SDK token counts were available for responding calls; cost was unavailable
because the SDK does not return price. No response text or image bytes are in
the evidence.

Terra remains the production model. Luna passed the small accuracy suite but
did not show a consistent latency advantage: the three ordinary pages averaged
3.43 seconds for Luna versus 3.38 seconds for Terra. With no verified dollar
cost advantage in the returned usage, switching would not substantiate a speed
or cost improvement. Mini was faster on ordinary pages, but its overflow
qualification remains incomplete. This change does not enable patient model selection or promote a
candidate in production. The conservative fallback is explicit: any exact
field/row/overflow regression blocks promotion, and an inconclusive/no-response
case retains terra.