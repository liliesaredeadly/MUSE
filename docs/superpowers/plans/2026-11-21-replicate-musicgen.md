# Replicate MusicGen connection

**Goal:** Connect the existing Muse neural-preview workflow to Replicate with a private server-side credential, while retaining local CPU inference.

**Architecture:** A provider factory selects the existing loopback engine or a bounded Replicate adapter. Existing recording snapshots, producer prompts, job IDs, cancellation, validated WAV downloads and comparison stay in place. Replicate explicitly uses its hosted `melody-large` variant; it is not represented as the local 1.5B checkpoint.

**Constraints:** Never print or commit credentials. Never run paid inference during implementation. Never retry an ambiguous prediction creation automatically. Original audio remains available. No claims of exact melody preservation or tested hosted audio without a genuine approved generation.

- [x] Add and test provider selection, including an explicit local override and missing/invalid configuration.
- [x] Implement and test audio-conditioned Replicate predictions, bounded polling/downloads, cancellation and private errors using simulated provider responses.
- [x] Validate the actual hosted checkpoint identity and retain its provider provenance in existing jobs.
- [x] Update the existing preview panel with cloud upload/cost disclosure and a paid-generation action label.
- [x] Verify saved credential presence without displaying it; the token was absent, so live authentication remains unverified.
- [x] Run the Node suite and build, review the patch, and record genuine verification limits.
- [ ] Publish the authorized Muse source changes to the configured liliesaredeadly/MUSE repository, excluding private data, credentials, archives and model weights.

The user explicitly requested the integration and then the Git push. Existing checkout and architecture are reused; no extra design approval or paid inference is inferred.
