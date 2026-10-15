---
name: pipeline-review
description: Run a weekly pipeline review or daily follow-up check with Solo CRM. Use when the user asks how their pipeline/sales are looking, what to do today, or who to follow up with.
---

# Pipeline review

## Daily "what should I do today?"
1. `list_follow_ups` with `due_within_days: 0` → overdue + due today.
2. For each, give one line: who, why, and a suggested action. Offer `draft_outreach` for each.
3. Mention the count of upcoming follow-ups this week (`due_within_days: 7`).

## Weekly review
1. `pipeline_summary` (default stale threshold 14 days).
2. Report in this order:
   - Open deals, open value and **weighted forecast** (lead 10%, qualified 25%, proposal 50%, negotiation 75%).
   - Stage breakdown as a compact table.
   - Win rate (won / (won + lost)), or say there isn't enough data yet.
   - **Stale deals**: name each with its last-touch date and recommend next step (nudge, re-engage, or mark lost).
   - Overdue follow-ups count.
3. Suggest at most 3 concrete actions. Each write still needs preview → approval → confirm.

## Interpreting
- Multiple currencies are summed without conversion. Say so when `note` is present.
- A deal stuck in `proposal` > 14 days usually needs a `proposal_nudge`; > 45 days, a `reengage` draft or closing as lost.
- Don't move deals between stages on your own judgement; propose it.
