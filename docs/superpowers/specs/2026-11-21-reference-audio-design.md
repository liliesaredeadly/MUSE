# Local audio reference matching

The user selected reference matching for the presentation and requested the official YouTube version of Alan Walker's Alone. The public source has been retrieved into the ignored `.local/reference-audio/` directory and decoded successfully. The existing hum, note editing, arrangement and instrument controls remain the composition workflow.

Use locally computed spectral chroma to compare a varied 5–15 second hum with the real reference recording. Return a possible matching passage and an original-source timestamp, or an explicit no-match result. Similarity is a heuristic score, not a calibrated probability or proof of song identity. Silence, repeated single pitches and insufficient input must not become matches.

The source is a produced mix. Its chroma is not a verified transcription of the lead melody. Do not substitute invented reference notes into the project or claim exact reproduction. The user keeps the actual captured notes and can use the existing sound controls after reviewing the reference suggestion. Verified reference-note replacement requires a separate, checked melody transcription.

Keep audio and derived features outside tracked/public assets. The server exposes metadata and match results only, with the same local-request checks and body/note bounds as existing APIs. Missing or invalid reference files report unavailability without breaking the studio. Query results clear when notes or projects change, and stale responses never replace a newer result.

The UI adds a compact panel to the existing capture component, preserving Atelier styling and Home/Discover. It includes source attribution, availability, explicit comparison, loading, retryable errors, no-match and candidate states. No external page opens automatically.

Validation uses generated tones and independent synthetic melodic references, negative queries, isolated HTTP fixtures and browser interaction. Live human humming against the real source remains a device check until exercised.
