import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./fixtures/csp";
import { analyzeFixture, mockOtari, OTARI } from "./support/agent";

const installed = "http://127.0.0.1:3015";

test("an owner downloads, installs and runs the assistant on its own origin", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await analyzeFixture(page, "bakery.fixture.test");
  const score = await page.getByTestId("score-total").innerText();
  const subject = encodeURIComponent(`Retrofit install for bakery.fixture.test:3011 (score ${score})`);
  await expect(page.getByRole("link", { name: "Email retrofit@thecreativetoken.com" })).toHaveAttribute("href", "mailto:retrofit@thecreativetoken.com?subject=" + subject);
  const downloadLink = page.getByRole("link", { name: "Download the files" });
  await expect(downloadLink).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadEvent;
  const name = download.suggestedFilename();
  expect(name).toMatch(/^retrofit-bakery\.fixture\.test-3011-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = testInfo.outputPath(name);
  await download.saveAs(zip);
  const dir = await mkdtemp(path.join(tmpdir(), "retrofit-installed-site-"));
  try {
    execFileSync("python3", ["-I", "-m", "zipfile", "-e", zip, dir]);
    const site = path.join(dir, name.slice(0, -4), "site");
    // Supply the existing website's home page. The bundle only adds the assistant.
    await writeFile(path.join(site, "index.html"), '<html lang="en"><title>Installed fixture</title><main>Opening hours <a href="/assistant/">Ask us</a></main></html>', { flag: "wx" });
    const listeners = spawnSync("lsof", ["-nP", "-iTCP:3015", "-sTCP:LISTEN"], { encoding: "utf8" });
    expect(listeners.status, listeners.stdout || listeners.stderr).toBe(1);
    const server = spawn(process.execPath, ["tools/agentic-web/scripts/serve_site.mjs", site, "--port", "3015"], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = once(server, "exit");
    try {
      await Promise.race([
        once(server.stdout, "data").then(([line]) => expect(String(line)).toContain("Open " + installed)),
        exited.then(([code]) => { throw new Error("Bundle server exited at startup: " + code); }),
      ]);
      const { networks } = JSON.parse(await readFile(path.join(site, "agent-manifest.json"), "utf8"));
      execFileSync(process.execPath, ["tools/agentic-web/scripts/check_partner.mjs", installed + "/" + networks[0].name], { timeout: 10_000 });
      // The normal analyze route permits this loopback origin in fixtures mode.
      await page.goto("/");
      await page.getByLabel("Your website address").fill(installed);
      await page.getByRole("button", { name: "Score my site" }).click();
      for (const check of ["aw.manifest", "aw.network-valid", "aw.cors"]) {
        await expect(page.getByTestId("check-" + check).locator("strong")).toHaveText("pass", { timeout: 20_000 });
      }

      const router = await mockOtari(page);
      await page.goto(installed + "/assistant/");
      await expect(page.getByRole("status")).toContainText("needs your AI provider key");
      expect(router.modelRequests + router.probes.length + router.bodies.length).toBe(0);
      await page.getByPlaceholder("Paste your API key").fill(OTARI.key);
      await page.getByRole("button", { name: "Save and start" }).click();
      await expect(page.getByRole("status")).toHaveText("Assistant connected to this page.");
      await page.locator("#ns-input").fill("What are your opening hours?");
      await page.locator("#ns-input").press("Enter");
      const answer = page.locator("#ns-msgs").getByText(/Our opening hours are Monday to Friday 7:00 to 18:00/).first();
      await expect(answer).toBeVisible();
      await expect(page.locator('#ns-msgs a[href^="http://bakery.fixture.test:3011/"]').first()).toBeVisible();
      expect(router.bodies.some(body => body.messages.some(m => m.role === "tool" && m.name === "website_search_site_content"))).toBe(true);
    } finally {
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
      await exited;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an expired result removes the download and offers a new analysis", async ({ page, request }) => {
  await analyzeFixture(page, "bakery.fixture.test");
  await expect(page.getByRole("link", { name: "Download the files" })).toBeVisible();
  try {
    const clock = await request.post("/test-fixtures/clock", { data: { offsetMs: 8 * 24 * 3600 * 1000 } });
    expect(clock.ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Analyze again" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download the files" })).toHaveCount(0);
  } finally {
    const reset = await request.post("/test-fixtures/clock", { data: { offsetMs: 0 } });
    expect(reset.ok()).toBe(true);
  }
});
