const { test, expect, eventPath } = require("./fixtures.cjs");

for (const language of ["it", "en"]) {
	test.describe(language, () => {
		test.use({ appLanguage: language });
		for (const width of [320, 390, 768, 1280]) {
			test(`every page fits its viewport and has no browser errors at ${width}px`, async ({ page }, testInfo) => {
				await page.setViewportSize({ width, height: 900 });
				const errors = [];
				page.on("pageerror", (error) => errors.push(error.message));
				page.on("console", (message) => {
					if (message.type() === "error") errors.push(message.text());
				});
				const capture = async (name) => {
					await expect(page.locator("main h1")).toBeVisible();
					await expect(page.locator("main h1.page-title > .icon")).toHaveCount(1);
					await expect
						.poll(() => page.locator("main h1 > .icon").evaluate((icon) => icon.getBBox().width))
						.toBeGreaterThan(0);
					expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
					const clipped = await page
						.locator(".hero-actions .btn, .segmented label")
						.evaluateAll((elements) =>
							elements
								.filter((element) => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1)
								.map((element) => element.textContent.trim()),
						);
					expect(clipped, `${name}: control labels fit their bounds`).toEqual([]);
					await page.screenshot({
						path: testInfo.outputPath(`${name}.png`),
						fullPage: !(await page.locator("dialog[open]").count()),
					});
				};
				await page.goto("/");
				await capture("events");
				await page.locator(".menu-trigger").click();
				await capture("settings-menu");
				await page.goto(eventPath);
				await capture("event");
				await page.locator('[data-action="share"]').click();
				await expect(page.getByRole("dialog")).toBeVisible();
				await capture("share");
				await page.goto("/#/new");
				await capture("new-event");
				const eventForm = page.locator('form[data-submit="save"]');
				await eventForm.locator('button:not([type="button"])').click();
				await expect(eventForm.locator(".field-error")).toHaveCount(2);
				await capture("event-validation");
				await eventForm.locator(".segmented label").nth(1).click();
				await expect(eventForm.locator(".invitee-list")).toBeVisible();
				await capture("invite-only");
				await page.goto(`${eventPath}/edit`);
				await capture("edit-event");
				await page.goto("/#/account");
				await capture("account");
				await page.evaluate(() => {
					window.__mock.token = "a".repeat(64);
					window.__mock.emit();
				});
				await expect(page.locator("#calendar-url")).toBeVisible();
				await capture("calendar");
				await page.goto("/#/admin");
				await capture("administration");
				await page.locator(".disclosure > summary").click();
				await capture("create-user");
				await page.locator('[data-action="editGroups"]').first().click();
				await expect(page.getByRole("dialog")).toBeVisible();
				await capture("user-groups");
				for (const box of await page.locator('#dialog [name="groups"]').all()) await box.uncheck();
				await page.locator('#dialog button[value="ok"]').click();
				await expect(page.locator("#dialog .form-error")).toBeVisible();
				await capture("groups-validation");
				await page.locator('#dialog button[value="cancel"]').click();
				await page.locator('[data-action="renameGroup"]').first().click();
				await page.locator("#dialog-input").evaluate((input) => {
					input.value = "x".repeat(61);
				});
				await page.locator('#dialog button[value="ok"]').click();
				await expect(page.locator("#dialog .field-error")).toBeVisible();
				await page.locator('#dialog button[value="cancel"]').click();
				await page.goto(eventPath);
				await expect(page.locator(".rsvp")).toBeVisible();
				await page.evaluate(() => {
					window.__mock.event.starts_at = new Date(Date.now() - 48 * 3600000).toISOString();
					window.__mock.emit();
				});
				await expect(page.locator(".hero.past")).toBeVisible();
				await capture("archived-event");
				await page.evaluate(() => {
					window.__mock.visible = false;
					window.__mock.emit();
				});
				await expect(page.locator(".hero")).toHaveCount(0);
				await capture("unavailable-event");
				await page.goto("/");
				await expect(page.locator(".event-card")).toBeVisible();
				await page.evaluate(() => {
					window.__mock.visible = false;
					window.__mock.emit();
				});
				await expect(page.locator(".event-card")).toHaveCount(0);
				await capture("empty-events");
				await page.evaluate(() => {
					window.__mock.profile.is_admin = false;
					window.__mock.emit();
				});
				await page.locator(".menu-trigger").click();
				await expect(page.locator('.menu-panel [href="#/admin"]')).toHaveCount(0);
				await page.evaluate(() => {
					location.hash = "#/admin";
				});
				await expect(page).toHaveURL(/#\/$/);
				await page.evaluate(() => window.__mock.authChange(null));
				await expect(page.locator(".auth-card")).toBeVisible();
				await capture("login");
				expect(errors).toEqual([]);
			});
		}
	});
}
