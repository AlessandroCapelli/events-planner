const { test, expect, eventPath } = require("./fixtures.cjs");

const fitsViewport = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("the administration shield renders in the menu and page heading", async ({ page }) => {
	await page.goto("/#/admin");
	const headingIcon = page.locator(".page-admin h1 .icon");
	await expect(headingIcon).toBeVisible();
	await expect.poll(() => headingIcon.evaluate((icon) => icon.getBBox().width)).toBeGreaterThan(0);
	await page.locator(".menu-trigger").click();
	const menuIcon = page.locator('.menu-panel [href="#/admin"] .icon');
	await expect(menuIcon).toBeVisible();
	await expect(menuIcon.locator("use")).toHaveAttribute("href", /#shield$/);
	await expect.poll(() => menuIcon.evaluate((icon) => icon.getBBox().width)).toBeGreaterThan(0);
});

for (const width of [320, 390, 900, 1280]) {
	test(`badges, avatars and long names stay inside the layout at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 850 });
		await page.goto("/");
		const badge = page.locator(".event-card .pill.pending");
		await expect(badge).toHaveCSS("padding-top", "0px");
		await expect(badge).toHaveCSS("border-top-width", "0px");
		const cardBox = await page.locator(".event-card").boundingBox();
		const badgeBox = await badge.boundingBox();
		expect(badgeBox.x).toBeGreaterThanOrEqual(cardBox.x);
		expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
		expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
		await expect(page.locator(".avatar.more")).toHaveCSS("margin-top", "0px");
		expect(await fitsViewport(page)).toBe(true);
		await page.locator(".event-card").click();
		await expect(page.locator(".pending-people")).toBeVisible();
		const chip = await page
			.locator(".chip")
			.filter({ hasText: "X".repeat(60) })
			.boundingBox();
		expect(chip.x + chip.width).toBeLessThanOrEqual(width);
		expect(await fitsViewport(page)).toBe(true);
		await page.getByRole("button", { name: "Share", exact: true }).click();
		await expect(page.locator(".share-target").first()).toHaveText("WhatsApp");
		await expect(page.getByRole("dialog")).toHaveAccessibleName("Share the event");
	});
}

test("a slow response does not reopen the event after navigating away", async ({ page }) => {
	await page.goto(eventPath);
	await expect(page.locator(".rsvp")).toBeVisible();
	await page.evaluate(() => {
		window.__mock.holdResponse = true;
	});
	await page.getByRole("button", { name: "I'm in", exact: true }).click();
	await page.waitForFunction(() => !!window.__mock.releaseResponse);
	await page.locator(".brand").click();
	await expect(page.locator(".event-list")).toBeVisible();
	await page.evaluate(() => window.__mock.releaseResponse());
	await expect(page.locator(".event-list")).toBeVisible();
	await expect(page.locator(".rsvp")).toHaveCount(0);
	await expect(page).toHaveURL(/#\/$/);
});

test("Realtime keeps a draft being submitted and blocks double submits", async ({ page }) => {
	await page.goto(eventPath);
	const form = page.locator('form[data-submit="propose"]');
	const location = form.locator('[name="location"]');
	const submit = form.getByRole("button", { name: "Propose", exact: true });
	await location.fill("Draft to keep");
	await page.evaluate(() => {
		window.__mock.holdProposal = true;
	});
	await submit.click();
	await page.waitForFunction(() => !!window.__mock.rejectProposal);
	await page.evaluate(() => {
		window.__mock.event.items.push({
			id: "remote",
			label: "Added by another user",
			created_at: new Date().toISOString(),
		});
		window.__mock.emit();
	});
	await page.waitForTimeout(600);
	await expect(location).toHaveValue("Draft to keep");
	await expect(submit).toBeDisabled();
	await form.evaluate((el) => el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
	expect(await page.evaluate(() => window.__mock.proposeCalls)).toBe(1);
	await page.evaluate(() => window.__mock.rejectProposal());
	await expect(form.locator(".form-error")).toHaveText(/Saving failed/);
	await expect(page.locator(".items-card .rows")).toContainText("Added by another user");
	await expect(location).toHaveValue("Draft to keep");
	await expect(submit).toBeEnabled();
});

test("a successful submit clears the form even after a concurrent refresh", async ({ page }) => {
	await page.goto(eventPath);
	const form = page.locator('form[data-submit="addItem"]');
	await form.locator("input").fill("Drinks");
	await page.evaluate(() => {
		window.__mock.holdItem = true;
	});
	await form.getByRole("button", { name: "Add", exact: true }).click();
	await page.waitForFunction(() => !!window.__mock.releaseItem);
	await page.evaluate(() => window.__mock.emit());
	await page.waitForTimeout(400);
	await expect(form.locator("input")).toHaveValue("Drinks");
	await page.evaluate(() => window.__mock.releaseItem());
	await expect(form.locator("input")).toHaveValue("");
	await expect(page.locator(".items-card .rows")).toContainText("Drinks");
});

test("the current user's name and role update without signing in again", async ({ page }) => {
	await page.goto(eventPath);
	const edit = page.getByRole("link", { name: "Edit", exact: true });
	await expect(edit).toBeVisible();
	await page.evaluate(() => {
		Object.assign(window.__mock.profile, { display_name: "New name", is_admin: false });
		window.__mock.emit();
	});
	await expect(edit).toHaveCount(0);
	await page.locator(".menu-trigger").click();
	await expect(page.locator(".menu-head")).toContainText("New name");
	await expect(page.locator(".menu-panel").getByRole("link", { name: "Administration" })).toHaveCount(0);
});

test("the safety refresh removes an event that is no longer visible", async ({ page }) => {
	await page.clock.install();
	await page.goto(eventPath);
	await expect(page.locator(".rsvp")).toBeVisible();
	await page.evaluate(() => {
		window.__mock.visible = false;
	});
	await page.clock.fastForward(5 * 60e3 + 1000);
	await expect(page.getByRole("heading", { name: "Event not available" })).toBeVisible();
	await expect(page.locator(".rsvp")).toHaveCount(0);
});

test("an event starts and ends on screen without writes or tab switches", async ({ page }) => {
	await page.clock.install();
	await page.goto(eventPath);
	await expect(page.locator(".rsvp")).toBeVisible();
	const startIn = (ms) =>
		page.evaluate((offset) => {
			window.__mock.event.starts_at = new Date(Date.now() + offset).toISOString();
			window.__mock.emit();
		}, ms);
	await startIn(1000);
	await page.clock.fastForward(300);
	await expect(page.locator(".hero .pill.live")).toHaveCount(0);
	await page.clock.fastForward(1100);
	await expect(page.locator(".hero .pill.live")).toHaveText("Happening now");
	await startIn(-12 * 3600000 + 1000);
	await page.clock.fastForward(300);
	await page.clock.fastForward(1100);
	await expect(page.locator(".notice").first()).toContainText("This event has ended");
	await expect(page.getByRole("button", { name: "I'm in", exact: true })).toBeDisabled();
});

test("events that started yesterday are not listed under Today", async ({ page }) => {
	await page.clock.install({ time: new Date("2026-10-24T00:30:00+02:00") });
	await page.goto("/");
	await expect(page.locator(".event-card")).toBeVisible();
	await page.evaluate(() => {
		window.__mock.event.starts_at = new Date(Date.now() - 3600000).toISOString();
		window.__mock.emit();
	});
	await page.clock.fastForward(300);
	await expect(page.locator(".group-label")).toHaveText("Yesterday");
});

test("a password reset keeps leading and trailing spaces", async ({ page }) => {
	await page.goto("/#/admin");
	await page.locator('[data-action="resetPassword"][data-id="other"]').click();
	await page.locator("#dialog-input").fill(" password with spaces ");
	await page.getByRole("dialog").getByRole("button", { name: "Reset password", exact: true }).click();
	await page.waitForFunction(() => !!window.__mock.lastAdmin);
	expect(await page.evaluate(() => window.__mock.lastAdmin.password)).toBe(" password with spaces ");
});

test("a profile that loads late does not restore the session after sign-out", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator(".event-card")).toBeVisible();
	await page.evaluate(() => {
		window.__mock.holdProfile = true;
		window.__mock.authChange({ id: "second", email: "second@example.test" });
	});
	await page.waitForFunction(() => !!window.__mock.releaseProfile);
	await page.evaluate(() => window.__mock.authChange(null));
	const signIn = page.getByRole("button", { name: "Sign in", exact: true });
	await expect(signIn).toBeVisible();
	await page.evaluate(() => window.__mock.releaseProfile());
	await expect(signIn).toBeVisible();
	await expect(page.locator(".event-card")).toHaveCount(0);
});

test("navigating closes the dialog and cancels its action", async ({ page }) => {
	await page.goto("/#/admin");
	await page.locator('[data-action="resetPassword"][data-id="other"]').click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.evaluate(() => {
		location.hash = "#/";
	});
	await expect(page.locator(".event-card")).toBeVisible();
	await expect(page.getByRole("dialog")).not.toBeVisible();
	expect(await page.evaluate(() => window.__mock.lastAdmin)).toBeUndefined();
});

test("saving the name keeps an unsent password draft", async ({ page }) => {
	await page.goto("/#/account");
	const password = page.locator('form[data-submit="password"] [name="password"]');
	await password.fill("Password not sent yet");
	const form = page.locator('form[data-submit="name"]');
	await form.locator("input").fill("Updated name");
	await form.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.locator(".profile-name")).toHaveText("Updated name");
	await expect(password).toHaveValue("Password not sent yet");
});

test("the group filter narrows the list and is remembered", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator(".event-card")).toContainText("Default");
	await page.getByRole("button", { name: "Climbing", exact: true }).click();
	await expect(page.locator(".event-card")).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole("button", { name: "Climbing", exact: true })).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator(".event-card")).toHaveCount(0);
	await page.getByRole("button", { name: "All", exact: true }).click();
	await expect(page.locator(".event-card")).toHaveCount(1);
});

test("polls are validated, created and voted on", async ({ page }) => {
	await page.goto(eventPath);
	const form = page.locator('form[data-submit="createPoll"]');
	const create = form.getByRole("button", { name: "Create poll", exact: true });
	await form.locator('[name="question"]').fill("Pizza or sushi?");
	await form.locator('[name="options"]').fill("Pizza\n Pizza \n");
	await create.click();
	await expect(form.locator(".field-error")).toContainText("2 to 10");
	await form.locator('[name="options"]').fill("Pizza\nSushi");
	await create.click();
	await expect(form.locator('[name="question"]')).toHaveValue("");
	const pizza = page.locator(".poll-option").filter({ hasText: "Pizza" });
	const sushi = page.locator(".poll-option").filter({ hasText: "Sushi" });
	await sushi.click();
	await expect(sushi).toHaveAttribute("aria-pressed", "true");
	await expect(sushi.locator(".poll-count")).toHaveText("1");
	await pizza.click();
	await expect(pizza).toHaveAttribute("aria-pressed", "true");
	await expect(sushi).toHaveAttribute("aria-pressed", "false");
	await pizza.click();
	await expect(pizza).toHaveAttribute("aria-pressed", "false");
});
