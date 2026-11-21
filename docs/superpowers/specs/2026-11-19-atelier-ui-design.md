# MUSE atelier interface direction

## Intent and scope

The user requests a noticeable interface redesign informed by Saint Laurent and PUMA, and explicitly excludes the homepage and Discover domains page. Redesign Studio, HUM, producer direction and Projects only. Preserve all recording, arranging, editing, saving, playback and export behavior. Do not commit or push.

## Approach

Use Saint Laurent's restrained monochrome presentation and editorial spacing, combined with the weight and directness of PUMA's campaign typography. Retain the existing music workflow rather than importing ecommerce navigation or brand assets. A wholesale global rebrand would violate the protected-page requirement; a small spacing-only polish would not satisfy the requested visual change.

## Visual system

- Ink `#0B0B0C`, ivory `#F3F2ED`, graphite `#202021`, silver `#A6A6A0`, line `#3B3B3C`. The existing orange remains meaningful only for recording/live actions.
- Condensed system display typography (Bahnschrift / Arial Narrow / sans-serif), uppercase headings with tight line spacing. Arial/Helvetica body at readable sizes. Functional controls remain at least 40px, with 44px touch targets.
- Studio: deep black workbench, oversized white heading, disciplined track rows and compact charcoal control surfaces. No purple/pink decorative chrome.
- HUM: grayscale treatment of the existing stage image only on this page, bold white display type and a crisp ivory recording console. Actual device, input level and capture feedback remain visible.
- Producer direction: neutral ivory editorial form beside a black proposal panel. Preserve the actual melody preview and explicit Apply/Create step.
- Projects: monochrome record-sleeve gallery using real saved metadata. Empty remains empty.
- Buttons: square geometry, clear monochrome primary/secondary hierarchy, visible hover/focus and genuinely disabled states. Motion is limited to short color/opacity feedback and respects reduced motion.

## Protection and implementation

New CSS is scoped through `.reference-page-studio`, `.reference-page-hum`, `.reference-page-direction` and `.reference-page-library`. Do not change global root tokens, `styles.css`, existing Home/Discover markup, existing reference stylesheets, or shared image files. Load new scoped modules after the current styles. Source/assets and Home/Discover functions are snapshotted in ignored `.local/luxury-ui-baseline` for comparison.

## Verification

Run the existing automated suite, production build, static UI audit and available runtime/browser checks. Verify protected source/assets remain identical, no new rule matches the protected pages, and check desktop plus 390px/320px wrapping on changed pages. Keep synthetic QA data isolated from real projects. A real-microphone retest remains deferred by the user.

## References

- https://www.ysl.com/en-us
- https://us.puma.com/us/en

The typography/palette/layout choices above are design interpretations of the reference sites, not claims of affiliation or copied brand design assets.
