import type { Metadata } from "next";
import { LegalPage } from "../components/LegalPage";

export const metadata: Metadata = { title: "Terms · SafeDeal" };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      sections={[
        {
          heading: "A demo on the PayPal sandbox",
          body: [
            "SafeDeal is built for the PayPal hackathon. It uses PayPal sandbox accounts and test money only. Do not use it for real purchases.",
          ],
        },
        {
          heading: "How deals work",
          body: [
            "Both people confirm the same terms before anyone pays. The buyer's PayPal payment is held, not taken. It is paid to the seller on proof of delivery or when the buyer confirms receipt, and released back to the buyer if the seller misses the ship-by date.",
            "These rules are applied by SafeDeal's rule engine. AI suggestions help fill in the terms and summarise evidence, but never decide where money goes.",
          ],
        },
        {
          heading: "Your part",
          body: [
            "Give true information, use only your own PayPal account, and keep your private deal links to yourself: anyone with a link can act as that party.",
          ],
        },
        {
          heading: "No warranty",
          body: [
            "The service is provided as is, with no guarantee that it is available or free of errors, and may change or stop at any time.",
          ],
        },
      ]}
    />
  );
}
