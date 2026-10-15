---
name: crm-safe-writes
description: How to change Solo CRM data safely. Use whenever adding, updating or deleting contacts, deals, follow-ups or activities with the solo-crm tools.
---

# Writing to Solo CRM: preview, approve, confirm

Every write tool (`upsert_contact`, `delete_contact`, `upsert_deal`, `delete_deal`, `add_follow_up`, `complete_follow_up`, `log_activity`) is **two-step**.

1. **Preview.** Call the tool *without* `confirm_token`. Nothing is saved. You get `summary`, `changes` and a `confirm_token`.
2. **Ask.** Show the user the `summary` (and the from → to `changes` for updates) in one short message. For deletes, quote the cascade counts. Wait for a clear yes.
3. **Confirm.** Call the same tool with **exactly the same arguments** plus `confirm_token`.

Rules:
- Never confirm in the same turn as the preview unless the user's request already explicitly approved that exact change (e.g. "yes, log it"). When in doubt, ask.
- Tokens are single-use, expire after 10 minutes, and are invalidated by any other change. If you get "does not match" or "CRM changed", re-run the preview and show it again. Don't retry blindly.
- Batch requests ("add these 5 contacts"): preview all, show one combined list, then confirm each after a single approval.
- Resolve ids first with `list_contacts` / `list_deals`. Never invent ids.
- If `upsert_contact` reports an existing email, update that contact instead of creating a duplicate.

Typical flows:
- *"Met Sam from Rivera Studio, wants a logo, ~$800"* → `upsert_contact` (preview) + `upsert_deal` stage `lead` value 800 (preview) → one approval → confirm both → offer to `add_follow_up`.
- *"Sam signed!"* → `list_deals` → `upsert_deal` `{deal_id, stage:"won"}` → approve → confirm → offer a `thank_you` draft.
