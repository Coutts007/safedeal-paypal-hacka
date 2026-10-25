import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

// Uploading an exported chat: the file is turned into text in the browser, shown in the box and
// sent to the AI (the e2e server has no AI key, so it answers "not set up", which is fine here).

test("an iPhone WhatsApp zip is read in the browser and sent to the AI as text", async ({
  page,
}) => {
  const chat =
    "[20/10/2026, 9:01:00 PM] Shemaya: Is the Tecno Spark still available?\n" +
    "[20/10/2026, 9:03:00 PM] David: Yes, 12k. G4S kesho\n" +
    "[20/10/2026, 9:04:00 PM] David: ‎image omitted";
  const zip = Buffer.from(zipSync({ "_chat.txt": strToU8(chat) }));

  await page.goto("/");
  const sent = page.waitForRequest("**/api/extract");
  await page.getByLabel("Upload an exported chat").setInputFiles({
    name: "WhatsApp Chat - Shemaya.zip",
    mimeType: "application/zip",
    buffer: zip,
  });
  const body = (await sent).postDataJSON() as { chat: string };
  expect(body.chat).toBe(
    "20/10/2026, 21:01 - Shemaya: Is the Tecno Spark still available?\n" +
      "20/10/2026, 21:03 - David: Yes, 12k. G4S kesho",
  );
  await expect(page.getByRole("status")).toHaveText(
    "WhatsApp chat loaded: all 2 messages (2026-10-20 to 2026-10-20).",
  );
  await expect(page.getByLabel("Or paste your chat with the buyer")).toHaveValue(body.chat);
  await expect(page.getByText(/Reading chats is not set up/)).toBeVisible();
});

test("a file with no chat in it gets a plain message", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Upload an exported chat").setInputFiles({
    name: "photo.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zipSync({ "IMG_0001.jpg": new Uint8Array([0xff, 0xd8]) })),
  });
  await expect(page.getByText(/could not find a chat in that file/)).toBeVisible();
});
