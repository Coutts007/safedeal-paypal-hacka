// Untrusted text (chat messages, evidence notes, captions) reaches the model inside tags such as
// <chat> or <note>. Angle brackets become look-alike characters so the text can never close its
// tag or open one of SafeDeal's (rule 5); the model still reads it as written.
export function neutralise(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}
