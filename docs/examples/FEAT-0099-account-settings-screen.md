---
id: FEAT-0099
title: Account settings screen
status: draft
platforms: [web, ios, android]
depends_on: []
---

## Intent

Let users update their account profile (display name, email, language) without contacting support. This is a maintenance surface, not a growth surface — optimize for trust and reversibility over engagement. The one reliable way to destroy a user's trust in a product is to silently corrupt their profile, so errors and network hiccups must be visible and recoverable.

## Behavior

The user navigates to the account settings screen from the app's main navigation:

- **Web**: `/settings/account` route, reached from the user menu in the top bar.
- **Mobile**: "Account" row inside the Settings tab (iOS) or Settings screen (Android), reached from the main tab bar.

The screen presents three editable fields — display name, email, language — populated with the user's current values. Edits are staged locally; the user commits them with Save (enabled only when changes exist and are valid) or discards them with Cancel.

Email changes require confirmation via a link sent to the new address; until confirmed, the stored email remains the old one and a banner shows the pending new value. Display name and language apply immediately on save.

Navigation away from the screen with unsaved changes prompts the user to save, discard, or stay.

Validation:

- Display name: 1–50 characters, no leading or trailing whitespace.
- Email: standard email shape; uniqueness checked on save (server-side).
- Language: selected from the app's supported-language list.

## Constraints

- All form fields are reachable and operable by keyboard alone (web) or assistive technology (all platforms). Tab/focus order follows visual order top-to-bottom.
- Touch targets ≥ 44×44 pt on mobile, ≥ 32×32 px on web.
- Unsaved edits must never be lost without explicit user choice — navigation, browser back, tab close, app backgrounding, and pull-to-refresh all prompt.
- The screen must be usable at viewports from 320px wide (small mobile) to 1920px wide (desktop).
- No third-party trackers or analytics on this screen beyond first-party error reporting. Settings pages are a sensitive surface.
- All user-visible strings are localized; the language selector reflects the app's supported-locales list.
- Offline reads work against the last-cached profile. Offline writes are rejected with a clear "you're offline" message, not silently queued (see Non-goals).

## Examples

Mockups and reference screens live at `specs/assets/FEAT-0099/` (mobile, tablet, desktop widths; pending-email banner and error states).

**Primary save flow (all platforms):**

1. User opens the account settings screen. The three fields populate with the current profile.
2. User edits the display name. The Save button becomes enabled.
3. User taps Save. The button shows a spinner; fields become read-only.
4. Server responds success. Fields unlock, Save disables, a transient "Saved" confirmation appears for ~2 seconds.
5. User navigates away. No unsaved-changes prompt.

**Email-change flow:**

1. User edits the email field and taps Save.
2. Server accepts the request but does not yet change the stored email. A banner appears beneath the email field: "Confirmation link sent to new@example.com. The change takes effect once confirmed."
3. The email field reverts to the stored (old) value; the pending new value is shown in a subdued style below.
4. If the user edits the email again before confirming, the previous pending confirmation is invalidated and a new link is sent.

**Validation-error flow:**

1. User clears the display name. Save disables and an inline message under the field reads: "Display name is required."
2. User enters a 51-character name. Field shows "Display name must be 50 characters or fewer" and Save stays disabled.

**Server-error flow:**

1. User saves with a valid form. Server rejects with "email already in use."
2. Fields unlock, Save re-enables, and an inline error under the email field shows the server's reason. Other fields retain the user's edits.

**Offline flow:**

1. User edits the display name while offline.
2. User taps Save. The button shows "You're offline" and the request is not attempted. Edits remain in the form.
3. Connectivity returns. Save re-enables. The user must tap Save again — no silent retry.

## Acceptance criteria

- AC-1: Given the user is authenticated and navigates to the account settings screen, when the screen loads, then display name, email, and language fields are populated with the user's current profile within 1 second on a warm cache.
- AC-2: Given the user edits any field with a valid value differing from the current profile, then the Save button is enabled; given no fields differ or any field is invalid, Save is disabled.
- AC-3: Given the user taps Save with a valid form, when the request succeeds, then the profile is updated (display name and language immediately; email via pending confirmation) and a "Saved" confirmation appears for ~2 seconds.
- AC-4: Given the user changes the email and saves successfully, then the stored email is unchanged, a confirmation link is sent to the new address, and the UI shows the pending new email in a subdued style beneath the current email.
- AC-5: Given a display name outside 1–50 characters or containing leading or trailing whitespace, when the user attempts to save, then inline validation displays before any server request and Save remains disabled.
- AC-6: Given the server rejects the save (e.g., duplicate email), when the response arrives, then fields unlock, the user's edits remain, and an inline error under the offending field shows the server's reason.
- AC-7: Given the user has unsaved changes, when the user attempts to leave the screen (navigation, browser back, tab or window close on web, back gesture or button on mobile, app backgrounding on mobile), then a prompt offers Save / Discard / Stay.
- AC-8: Given the user is offline, when the user taps Save, then the request is not attempted, the Save button shows "You're offline," and edits remain in the form.
- AC-9: Given the screen is rendered at viewport widths from 320px to 1920px, then all fields and actions are visible, operable, and not clipped.
- AC-10: Given an assistive-technology user (web screen reader, VoiceOver, TalkBack) traverses the form, then each field announces its label, current value, validation state, and error (if any).
- AC-11 *(web only)*: Given the user has entered unsaved changes, when they use the browser's back button, then the unsaved-changes prompt from AC-7 appears before navigation completes.
- AC-12 *(mobile only)*: Given the software keyboard opens over a focused field, when the field would otherwise be obscured, then the scroll position adjusts so the field remains visible above the keyboard.

## Out of scope

- Password change — separate spec with different confirmation semantics.
- Two-factor authentication management — separate spec.
- Notification preferences — belong on a separate settings screen.
- Account deletion — separate spec, different recovery semantics.
- Deep-linking directly to a specific field via URL fragment.
- Admin or impersonation flows.

## Non-goals

- No silent offline write queuing. Queued settings writes create "I thought I saved that" bugs and subtle merge conflicts; explicit "you're offline" is the correct failure.
- No analytics on field-level interactions. This screen must feel private; only error and performance telemetry is allowed.
- No auto-save. Settings changes are high-consequence; explicit Save prevents accidental edits.
- No animation for delight. Transitions communicate state (saving, saved, error), not entertainment.
- No cross-device real-time sync of unsaved edits. Draft state lives in one client session.

## Open questions

- Do we surface password-change and 2FA entry points on this screen, or only link out to their standalone screens? *Decide alongside the account-security spec (not yet written).*
- Language selector: show language names in their native form only ("Español"), or localized to the current UI language ("Spanish (Español)")? *Decide after one round of localization review; lean native-form for clarity.*
- On mobile, is Save a toolbar button (top-right, platform convention) or a bottom action bar? *Decide in platform-specific design review before implementation; format-level, both fit.*
- How do we handle an email-confirmation link clicked from a different account session (user logged in as a different account)? *Decide with the auth team; likely force re-auth before applying.*
