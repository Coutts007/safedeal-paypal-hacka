import type { Metadata } from "next";
import { LegalPage } from "../components/LegalPage";

export const metadata: Metadata = { title: "Privacy · SafeDeal" };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      sections={[
        {
          heading: "What SafeDeal keeps",
          body: [
            "For a deal: the names and terms both people confirm, the chat the seller pastes, photos and notes added as evidence, tracking numbers, PayPal order and payment ids, and a log of every step.",
            "For sellers who log in with PayPal: the PayPal user id, name and email PayPal shares, and the time of the last login. SafeDeal never sees or stores your PayPal password or PayPal login token.",
          ],
        },
        {
          heading: "Why",
          body: [
            "To hold the payment, release it on proof of delivery or return it when the seller misses the deadline, to show each deal to its two parties, and to build the evidence bundle for a PayPal dispute.",
            "The pasted chat and evidence are read by an AI model (Anthropic Claude) to propose deal terms and summarise evidence. The AI cannot move money.",
          ],
        },
        {
          heading: "Who sees it",
          body: [
            "Only the two people holding the deal's private links, a SafeDeal reviewer when a problem is reported, and PayPal for the payment itself. Nothing is sold or shared for advertising.",
          ],
        },
        {
          heading: "Your choices",
          body: [
            "Log out at any time from the dashboard. As a demo, data may be deleted without notice. Questions: open an issue on the project's GitHub repository.",
          ],
        },
      ]}
    />
  );
}
