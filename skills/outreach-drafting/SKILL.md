---
name: outreach-drafting
description: Draft follow-up emails and DMs from CRM context with Solo CRM's draft_outreach. Use when the user wants to write to a contact, nudge a proposal, check in or say thanks.
---

# Drafting outreach

`draft_outreach` **only drafts text**. Solo CRM has no network access and cannot send anything. Never tell the user a message was sent.

## Steps
1. Find the contact (`list_contacts`) and optionally `get_contact` to read recent history.
2. Pick the `purpose`:
   - `intro`: first contact
   - `follow_up`: after a call/meeting/email
   - `proposal_nudge`: proposal sent, no reply
   - `check_in`: past client, keeping warm
   - `thank_you`: after a win or a referral
   - `reengage`: went quiet for weeks
3. Set `tone` (`friendly` default, `professional`, `brief`), `channel` (`email` or `dm`), up to 5 `key_points`, and `sender_name` if known.
4. Treat the output as a solid first draft. Personalise one line using `get_contact` notes, keep it under ~120 words, and end with one clear question.
5. Present subject + body. After the user sends it themselves, offer to `log_activity` (type `email`/`dm`) and `add_follow_up` in 3–5 days, both through the usual preview → confirm flow.
