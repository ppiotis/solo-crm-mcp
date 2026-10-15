export const PURPOSES = ["intro", "follow_up", "proposal_nudge", "check_in", "thank_you", "reengage"];
const firstName = (n) => n.trim().split(/\s+/)[0];
export function draftOutreach(i) {
    const tone = i.tone ?? "friendly";
    const channel = i.channel ?? "email";
    const name = firstName(i.contact.name);
    const greet = tone === "professional" ? `Hi ${name},` : tone === "brief" ? `${name},` : `Hey ${name},`;
    const topic = i.deal?.title ?? (i.contact.company ? `working with ${i.contact.company}` : "what you're working on");
    const lastRef = i.lastActivity ? ` since our last ${i.lastActivity.type === "note" ? "conversation" : i.lastActivity.type}` : "";
    const lines = {
        intro: { subject: `Quick intro${i.contact.company ? ` – ${i.contact.company}` : ""}`, body: `I came across ${i.contact.company ?? "your work"} and thought there could be a good fit with what I do.`, cta: "Open to a 15-minute chat next week?" },
        follow_up: { subject: `Following up: ${topic}`, body: `Just following up${lastRef} about ${topic}.`, cta: "Any questions I can answer to help you decide?" },
        proposal_nudge: { subject: `Re: proposal for ${topic}`, body: `Wanted to check you had a chance to look over the proposal for ${topic}.`, cta: "Happy to adjust scope or timing if that helps. Shall we lock in a start date?" },
        check_in: { subject: `Checking in`, body: `It's been a little while${lastRef}, so I wanted to check in and see how things are going.`, cta: "Anything on your plate I could help with?" },
        thank_you: { subject: `Thank you!`, body: `Thanks so much for ${i.deal?.stage === "won" ? `choosing me for ${topic}` : "your time"}. I really appreciate it.`, cta: "If anything comes up, just reply here." },
        reengage: { subject: `Still interested in ${topic}?`, body: `We spoke a while back about ${topic} and I didn't want it to slip through the cracks.`, cta: "Is this still a priority, or should I close the loop for now?" },
    };
    const t = lines[i.purpose];
    const points = (i.key_points ?? []).filter(Boolean);
    const pointText = points.length ? (tone === "brief" ? ` ${points.join(". ")}.` : `\n\n${points.map((p) => `- ${p}`).join("\n")}`) : "";
    const sign = i.sender_name ? `\n\n${tone === "professional" ? "Best regards" : "Cheers"},\n${i.sender_name}` : "";
    const body = tone === "brief" || channel === "dm" ? `${greet} ${t.body}${pointText} ${t.cta}${channel === "dm" ? "" : sign}` : `${greet}\n\n${t.body}${pointText}\n\n${t.cta}${sign}`;
    return { channel, to: channel === "email" ? i.contact.email ?? null : i.contact.name, subject: channel === "email" ? t.subject : null, body, context_used: { deal: i.deal?.title ?? null, last_activity: i.lastActivity ? `${i.lastActivity.type} on ${i.lastActivity.at.slice(0, 10)}` : null } };
}
